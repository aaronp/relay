import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
const HOME = mkdtempSync(join(tmpdir(), 'relay-home-'));
const MAIN = new URL('../cli/src/main.ts', import.meta.url).pathname;

beforeAll(async () => { env = await setup(); });
afterAll(() => env?.teardown());

async function relay(token: string, ...args: string[]) {
  const p = Bun.spawn(['bun', MAIN, ...args], {
    env: { ...process.env, HOME, RELAY_SERVER: env.uri, RELAY_DB: env.db, RELAY_TOKEN: token },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

test('group create, topic create, list, send, pull', async () => {
  const tok = await env.tokenFor('alice', ['ONBOARDED']);
  const ok = async (...a: string[]) => {
    const r = await relay(tok, ...a);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    return r.stdout;
  };
  await ok('group', 'create', '--name', 'example', '--permissions', '{"create-topic-policy":"ABC1235"}');
  await ok('topic', 'create', '--name', 'foo', '--group', 'example', '--permissions', '{"read-policy":"XYZ","write-policy":"HKI"}', '--lifetime', '1d');
  const list = await ok('topic', 'list', '--group', 'example');
  for (const s of ['foo', 'XYZ', 'HKI']) expect(list).toContain(s);
  await ok('send', '--topic', 'example.foo', '-m', 'hello world');
  expect(await ok('pull', '--topic', 'example.foo')).toContain('hello world');
  const json = JSON.parse((await ok('pull', '--topic', 'example.foo', '--json')).trim());
  expect(atob(json.payload)).toBe('hello world');
});

test('pull --after resumes from an id, and topic delete honours delete-policy', async () => {
  const tok = await env.tokenFor('bob', ['ONBOARDED']);
  const ok = async (...a: string[]) => {
    const r = await relay(tok, ...a);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    return r.stdout;
  };
  await ok('group', 'create', '--name', 'del');
  await ok('topic', 'create', '--name', 't', '--group', 'del', '--permissions', '{"delete-policy":"DEL"}');
  expect(await ok('topic', 'list', '--group', 'del')).toContain('delete=DEL');
  await ok('send', '--topic', 'del.t', '-m', 'one');
  await ok('send', '--topic', 'del.t', '-m', 'two');

  const first = JSON.parse((await ok('pull', '--topic', 'del.t', '--json')).trim().split('\n')[0]);
  const after = await ok('pull', '--topic', 'del.t', '--after', first.id);
  expect(after).toContain('two');
  expect(after).not.toContain('one');
  const bad = await relay(tok, 'pull', '--topic', 'del.t', '--after', 'soon');
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('invalid --after "soon"');

  const denied = await relay(await env.tokenFor('mallory', []), 'topic', 'delete', '--name', 't', '--group', 'del');
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain('delete_topic requires one of [DEL]');

  await (async () => {
    const r = await relay(await env.tokenFor('deleter', ['DEL']), 'topic', 'delete', '--name', 't', '--group', 'del');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  })();
  expect(await ok('topic', 'list', '--group', 'del')).toBe('');
});

test('server error goes to stderr with exit 1', async () => {
  const r = await relay(await env.tokenFor('mallory', []), 'group', 'create', '--name', 'nope', '--permissions', '{}');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('create_group requires one of [ONBOARDED]');
});

test('expired token message', async () => {
  const r = await relay(await env.tokenFor('old', [], -120), 'topic', 'list', '--group', 'example');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('token expired — run "relay auth"');
});

test('token about to expire counts as expired (no refresh available)', async () => {
  const r = await relay(await env.tokenFor('soon', [], 10), 'topic', 'list', '--group', 'example');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('token expired — run "relay auth"');
});
