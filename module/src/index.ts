import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { readPolicySaids } from './policy';

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

const spacetimedb = schema({ config, session });
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

export const init = spacetimedb.init(ctx => {
  ctx.db.config.insert({
    id: 0,
    admin: ctx.sender,
    trustedIssuer: 'https://oauth.kerits.id',
    createGroupPolicy: '',
    policyClaim: 'kerits.policySAIDs',
  });
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

export const mySession = spacetimedb.view(
  { name: 'my_session', public: true },
  t.option(session.rowType),
  ctx => ctx.db.session.identity.find(ctx.sender) ?? undefined
);
