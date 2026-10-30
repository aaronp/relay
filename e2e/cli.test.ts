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
