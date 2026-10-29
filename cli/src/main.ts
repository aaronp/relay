#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { connect, decodeExp, setLogLevel, type Client, type Envelope } from '@topics/client';
import { displayText, parseLifetime, parsePermissions, parseTopicAddr } from './args';
import { login, refresh } from './auth';
import { loadConfig, saveConfig, type Config } from './config';

const USAGE = `usage:
  chat auth
  chat group create --name <g> --permissions '{"create-topic-policy":"SAID"}'
  chat topic create --name <t> --group <g> --permissions '{"read-policy":"SAID","write-policy":["SAID",...]}' [--lifetime 7d]
  chat topic list --group <g>
  chat send --topic <g.t> (-m <text> | --file <path>)
  chat pull --topic <g.t> [--watch] [--json]
options: --server <ws(s)://...> --db <name> --issuer <url> --port <loopback port>`;

setLogLevel('warn'); // keep stdout clean for piping

const EXPIRED = 'token expired — run "chat auth"';
const MIN_VALIDITY_MS = 30_000; // don't start a command on a token that's about to lapse

const { values: o, positionals: [cmd, sub] } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' }, group: { type: 'string' }, topic: { type: 'string' },
    permissions: { type: 'string' }, lifetime: { type: 'string' },
    message: { type: 'string', short: 'm' }, file: { type: 'string' },
    watch: { type: 'boolean' }, json: { type: 'boolean' },
    server: { type: 'string' }, db: { type: 'string' }, issuer: { type: 'string' }, port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const need = (v: string | undefined, flag: string) => {
  if (!v) throw new Error(`missing --${flag}\n${USAGE}`);
  return v;
};

/** A live token: stored/env token, refreshed if expired; otherwise tell the user to re-auth. */
async function freshToken(cfg: Config): Promise<string> {
  const valid = (t?: string) => { try { return !!t && decodeExp(t) * 1000 - Date.now() > MIN_VALIDITY_MS; } catch { return false; } };
  if (valid(cfg.token)) return cfg.token!;
  if (!cfg.token && !cfg.refreshToken) throw new Error('not signed in — run "chat auth"');
  const r = cfg.tokenFromEnv ? undefined : await refresh(cfg);
  if (!r) throw new Error(EXPIRED);
  Object.assign(cfg, r);
  saveConfig(cfg);
  return r.token;
}

async function client(cfg: Config): Promise<Client> {
  return connect({
    uri: cfg.server,
    db: cfg.db,
    token: await freshToken(cfg),
    onExpired: async () => {
      if (cfg.tokenFromEnv) return undefined;
      const r = await refresh(cfg);
      if (r) { Object.assign(cfg, r); saveConfig(cfg); }
      return r?.token;
    },
  });
}

function printMessage(e: Envelope, json?: boolean) {
  const b64 = Buffer.from(e.payload).toString('base64');
  if (json) {
    console.log(JSON.stringify({ ...e, id: String(e.id), sentAt: e.sentAt.toISOString(), payload: b64 }));
    return;
  }
  let text: string;
  try { text = displayText(new TextDecoder('utf-8', { fatal: true }).decode(e.payload)); } catch { text = `base64:${b64}`; }
  console.log(`${e.sentAt.toISOString()} ${e.sender} ${text}`);
}

async function run(): Promise<number> {
  const cfg = loadConfig(o);
  if (o.help || !cmd) { console.log(USAGE); return o.help ? 0 : 1; }

  if (cmd === 'auth') {
    const r = await login(cfg);
    Object.assign(cfg, r);
    saveConfig(cfg);
    console.error(`signed in; token valid until ${new Date(decodeExp(r.token) * 1000).toISOString()}`);
    return 0;
  }

  const key = sub ? `${cmd} ${sub}` : cmd;
  const c = await client(cfg);
  try {
    switch (key) {
      case 'group create': {
        const p = parsePermissions(o.permissions ?? '{}', ['create-topic-policy']);
        await c.createGroup(need(o.name, 'name'), { createTopicPolicies: p['create-topic-policy'] ?? [] });
        return 0;
      }
      case 'topic create': {
        const p = parsePermissions(o.permissions ?? '{}', ['read-policy', 'write-policy']);
        await c.createTopic(parseTopicAddr(`${need(o.group, 'group')}.${need(o.name, 'name')}`), {
          readPolicies: p['read-policy'] ?? [],
          writePolicies: p['write-policy'] ?? [],
          lifetimeSecs: o.lifetime ? parseLifetime(o.lifetime) : undefined,
        });
        return 0;
      }
      case 'topic list': {
        for (const t of await c.listTopics(need(o.group, 'group')))
          console.log(o.json
            ? JSON.stringify(t)
            : `${t.address}\tread=${t.readPolicies.join(',')}\twrite=${t.writePolicies.join(',')}` +
              `${t.expiresAt ? `\texpires=${t.expiresAt.toISOString()}` : ''}`);
        return 0;
      }
      case 'send': {
        const payload = o.file
          ? new Uint8Array(await Bun.file(o.file).arrayBuffer())
          : new TextEncoder().encode(need(o.message, 'message (-m)'));
        await c.send(parseTopicAddr(need(o.topic, 'topic')), payload);
        return 0;
      }
      case 'pull': {
        const addr = parseTopicAddr(need(o.topic, 'topic'));
        if (!o.watch) {
          for (const e of await c.pull(addr)) printMessage(e, o.json);
          return 0;
        }
        c.watch(addr, e => printMessage(e, o.json));
        const why = await c.closed;
        if (why === 'expired') throw new Error(EXPIRED);
        throw new Error('connection closed');
      }
      default:
        throw new Error(`unknown command "${key}"\n${USAGE}`);
    }
  } finally {
    c.close();
  }
}

run().then(
  code => process.exit(code),
  e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
);
