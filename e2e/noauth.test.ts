import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect } from '../client/src';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(() => env?.teardown());

const anon = () => connect({ uri: env.uri, db: env.db });

test('auth is on by default: a connection without a token is rejected', async () => {
  await expect(anon()).rejects.toThrow();
});

test('only the admin can disable auth', async () => {
  const c = await connect({ uri: env.uri, db: env.db, token: await env.tokenFor('alice', ['ONBOARDED']) });
  try {
    await expect(c.conn.reducers.setAuthDisabled({ disabled: true })).rejects.toThrow('admin only');
    expect(await c.authDisabled()).toBe(false);
  } finally {
    c.close();
  }
});

test('auth disabled: anonymous clients create, send and read without any SAIDs', async () => {
  env.admin('set_auth_disabled', 'true');
  const a = await anon();
  const b = await anon();
  // a token from any issuer (here: the trusted one, but no SAIDs) is accepted too
  const t = await connect({ uri: env.uri, db: env.db, token: await env.tokenFor('tom', []) });
  try {
    expect(await a.authDisabled()).toBe(true);
    await a.createGroup('open', { createTopicPolicies: ['NOBODY'] });
    await b.createTopic('open.t', { readPolicies: ['NOBODY'], writePolicies: [] });
    await t.send('open.t', new TextEncoder().encode('hi'));
    await a.send('open.t', new TextEncoder().encode('yo'));
    const msgs = await b.pull('open.t');
    expect(msgs.map(m => new TextDecoder().decode(m.payload))).toEqual(['hi', 'yo']);
    expect(msgs[0].sender).toBe('tom');
    expect((await b.listTopics('open'))[0].readPolicies).toEqual(['NOBODY']);
  } finally {
    a.close(); b.close(); t.close();
  }
});

test('re-enabling auth rejects anonymous connections again and cuts their access', async () => {
  env.admin('set_auth_disabled', 'true');
  const a = await anon();
  try {
    env.admin('set_auth_disabled', 'false');
    await expect(a.createGroup('nope', { createTopicPolicies: [] })).rejects.toThrow();
    await expect(a.pull('open.t')).resolves.toEqual([]);
    await expect(anon()).rejects.toThrow();
  } finally {
    a.close();
  }
});

test('CLI: TOPICS_NO_AUTH=1 works with no token at all', async () => {
  env.admin('set_auth_disabled', 'true');
  const HOME = mkdtempSync(join(tmpdir(), 'chat-home-'));
  const chat = async (...args: string[]) => {
    const p = Bun.spawn(['bun', new URL('../cli/src/main.ts', import.meta.url).pathname, ...args], {
      env: { ...process.env, HOME, TOPICS_SERVER: env.uri, TOPICS_DB: env.db, TOPICS_NO_AUTH: '1', TOPICS_TOKEN: '' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    return stdout;
  };
  await chat('group', 'create', '--name', 'cli');
  await chat('topic', 'create', '--name', 'x', '--group', 'cli');
  await chat('send', '--topic', 'cli.x', '-m', 'no auth');
  expect(await chat('pull', '--topic', 'cli.x')).toContain('no auth');
});
