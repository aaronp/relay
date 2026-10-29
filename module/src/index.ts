import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { missingMessage, parseAddress, readPolicySaids, satisfies, validName } from './policy';

const MAX_PAYLOAD = 65536;
const SWEEP_MICROS = 15_000_000n;

const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(),
    admin: t.identity(),
    trustedIssuer: t.string(),
    createGroupPolicy: t.string(),
    policyClaim: t.string(),
  }
);

// Claims captured at connect: views can't see JWTs, so reads are filtered through this.
const session = table(
  { name: 'session' },
  {
    identity: t.identity().primaryKey(),
    subject: t.string(),
    policySaids: t.array(t.string()),
    expiresAt: t.timestamp(),
  }
);

const group = table(
  { name: 'group', public: true },
  {
    name: t.string().primaryKey(),
    owner: t.string(),
    createTopicPolicies: t.array(t.string()),
    createdAt: t.timestamp(),
  }
);

const topic = table(
  { name: 'topic', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    address: t.string().unique(),
    groupName: t.string().index('btree'),
    name: t.string(),
    owner: t.string(),
    readPolicies: t.array(t.string()),
    writePolicies: t.array(t.string()),
    createdAt: t.timestamp(),
    expiresAt: t.option(t.timestamp()),
  }
);

const message = table(
  { name: 'message' },
  {
    id: t.u64().primaryKey().autoInc(),
    topicId: t.u64().index('btree'),
    group: t.string(),
    topic: t.string(),
    sentAt: t.timestamp(),
    sender: t.string(),
    digest: t.string(),
    payload: t.array(t.u8()),
  }
);

const sweepTimer = table(
  { name: 'sweep_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({ config, session, group, topic, message, sweepTimer });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const getConfig = (ctx: Ctx) => ctx.db.config.id.find(0)!;

/** Verified-issuer, unexpired JWT claims for the caller, or throws. */
function callerClaims(ctx: Ctx) {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) throw new SenderError('a JWT is required');
  const cfg = getConfig(ctx);
  if (jwt.issuer !== cfg.trustedIssuer) throw new SenderError(`untrusted issuer ${jwt.issuer}`);
  const exp = jwt.fullPayload.exp;
  if (typeof exp !== 'number') throw new SenderError('token has no exp');
  const expiresAt = new Timestamp(BigInt(exp) * 1_000_000n);
  if (expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('token expired');
  return { sub: jwt.subject, saids: readPolicySaids(jwt.fullPayload, cfg.policyClaim), expiresAt };
}

type Action = 'create_group' | 'create_topic' | 'send';

/** Single gate for every write. */
// ponytail: policy match only; rate limits / quotas per subject go here when needed.
function authorize(ctx: Ctx, action: Action, target: { required: string[]; owner?: string }) {
  const claims = callerClaims(ctx);
  if (claims.sub !== target.owner && !satisfies(claims.saids, target.required))
    throw new SenderError(missingMessage(action, target.required));
  return claims;
}

function requireName(name: string) {
  if (!validName(name)) throw new SenderError(`invalid name "${name}"`);
}

export const init = spacetimedb.init(ctx => {
  ctx.db.config.insert({
    id: 0,
    admin: ctx.sender,
    trustedIssuer: 'https://oauth.kerits.id',
    createGroupPolicy: '',
    policyClaim: 'kerits.policySAIDs',
  });
  ctx.db.sweepTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SWEEP_MICROS) });
});

/** Drops expired sessions (cutting their reads) and expired topics with their messages. */
export const sweep = spacetimedb.reducer({ onSchedule: sweepTimer }, { timer: sweepTimer.rowType }, ctx => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const s of [...ctx.db.session.iter()])
    if (s.expiresAt.microsSinceUnixEpoch <= now) ctx.db.session.identity.delete(s.identity);
  for (const tp of [...ctx.db.topic.iter()]) {
    if (!tp.expiresAt || tp.expiresAt.microsSinceUnixEpoch > now) continue;
    for (const m of [...ctx.db.message.topicId.filter(tp.id)]) ctx.db.message.id.delete(m.id);
    ctx.db.topic.id.delete(tp.id);
  }
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  if (ctx.sender.isEqual(getConfig(ctx).admin)) return; // the publisher's CLI identity, for set_config
  const { sub, saids, expiresAt } = callerClaims(ctx);
  const row = { identity: ctx.sender, subject: sub, policySaids: saids, expiresAt };
  if (ctx.db.session.identity.find(ctx.sender)) ctx.db.session.identity.update(row);
  else ctx.db.session.insert(row);
});

export const setConfig = spacetimedb.reducer(
  { trustedIssuer: t.string(), createGroupPolicy: t.string(), policyClaim: t.string() },
  (ctx, args) => {
    const cfg = getConfig(ctx);
    if (!ctx.sender.isEqual(cfg.admin)) throw new SenderError('admin only');
    ctx.db.config.id.update({ ...cfg, ...args });
  }
);

export const createGroup = spacetimedb.reducer(
  { name: t.string(), createTopicPolicies: t.array(t.string()) },
  (ctx, { name, createTopicPolicies }) => {
    const { sub } = authorize(ctx, 'create_group', { required: [getConfig(ctx).createGroupPolicy].filter(Boolean) });
    requireName(name);
    if (ctx.db.group.name.find(name)) throw new SenderError(`group "${name}" already exists`);
    ctx.db.group.insert({ name, owner: sub, createTopicPolicies, createdAt: ctx.timestamp });
  }
);

export const createTopic = spacetimedb.reducer(
  {
    address: t.string(),
    readPolicies: t.array(t.string()),
    writePolicies: t.array(t.string()),
    lifetimeSecs: t.option(t.u64()),
  },
  (ctx, { address, readPolicies, writePolicies, lifetimeSecs }) => {
    const addr = parseAddress(address);
    if (!addr) throw new SenderError(`invalid name "${address}"`);
    const g = ctx.db.group.name.find(addr.group);
    if (!g) throw new SenderError(`no such group ${addr.group}`);
    const { sub } = authorize(ctx, 'create_topic', { required: g.createTopicPolicies, owner: g.owner });
    if (ctx.db.topic.address.find(address)) throw new SenderError(`topic "${address}" already exists`);
    ctx.db.topic.insert({
      id: 0n,
      address,
      groupName: addr.group,
      name: addr.topic,
      owner: sub,
      readPolicies,
      writePolicies,
      createdAt: ctx.timestamp,
      expiresAt: lifetimeSecs === undefined
        ? undefined
        : new Timestamp(ctx.timestamp.microsSinceUnixEpoch + lifetimeSecs * 1_000_000n),
    });
  }
);

export const send = spacetimedb.reducer(
  { address: t.string(), payload: t.array(t.u8()) },
  (ctx, { address, payload }) => {
    const tp = ctx.db.topic.address.find(address);
    if (!tp) throw new SenderError(`no such topic ${address}`);
    const { sub } = authorize(ctx, 'send', { required: tp.writePolicies, owner: tp.owner });
    if (payload.length > MAX_PAYLOAD)
      throw new SenderError(`payload too large (${payload.length} > ${MAX_PAYLOAD} bytes)`);
    ctx.db.message.insert({
      id: 0n,
      topicId: tp.id,
      group: tp.groupName,
      topic: tp.name,
      sentAt: ctx.timestamp,
      sender: sub,
      digest: bytesToHex(sha256(Uint8Array.from(payload))),
      payload,
    });
  }
);

export const mySession = spacetimedb.view(
  { name: 'my_session', public: true },
  t.option(session.rowType),
  ctx => ctx.db.session.identity.find(ctx.sender) ?? undefined
);

// 2.12 TS views take no parameters, so this returns every readable message; clients filter by topic_id.
// ponytail: recomputes over all topics/messages on every change. Fine for chat-sized data; switch to a
// query-builder semijoin (or parameterised view when supported) if it gets large.
export const myMessages = spacetimedb.view(
  { name: 'my_messages', public: true },
  t.array(message.rowType),
  ctx => {
    const s = ctx.db.session.identity.find(ctx.sender);
    if (!s) return [];
    return [...ctx.db.topic.iter()]
      .filter(tp => tp.owner === s.subject || satisfies(s.policySaids, tp.readPolicies))
      .flatMap(tp => [...ctx.db.message.topicId.filter(tp.id)]);
  }
);
