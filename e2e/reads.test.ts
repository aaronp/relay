import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type Client, type Envelope } from '../client/src';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
const open: Client[] = [];
const enc = (s: string) => new TextEncoder().encode(s);
const sha256Hex = async (b: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', b)).toString('hex');

async function as(sub: string, saids: string[], ttlSec = 3600, onExpired?: () => Promise<string | undefined>) {
  const c = await connect({ uri: env.uri, db: env.db, token: await env.tokenFor(sub, saids, ttlSec), onExpired });
  open.push(c);
  return c;
}

const until = async (cond: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (cond()) return true;
  return cond();
};

let writer: Client;
beforeAll(async () => {
  env = await setup();
  const alice = await as('alice', ['ONBOARDED']);
  await alice.createGroup('g', { createTopicPolicies: ['T'] });
  await alice.createTopic('g.r', { readPolicies: ['R'], writePolicies: ['W'] });
  writer = await as('writer', ['W']);
});
afterAll(() => { for (const c of open) c.close(); env?.teardown(); });

test('reader with read policy sees messages, others see none', async () => {
  await writer.send('g.r', enc('hi'));
  const msgs = await (await as('reader', ['R'])).pull('g.r');
  expect(msgs).toHaveLength(1);
  expect(msgs[0].sender).toBe('writer');
  expect(msgs[0].group).toBe('g');
  expect(msgs[0].topic).toBe('r');
  expect(msgs[0].digest).toBe(await sha256Hex(enc('hi')));
  expect(msgs[0].payload).toEqual(enc('hi'));
  expect(msgs[0].sentAt).toBeInstanceOf(Date);
  expect(await (await as('stranger', [])).pull('g.r')).toEqual([]);
});

test('topic owner can read without the read policy', async () => {
  expect((await (await as('alice', ['ONBOARDED'])).pull('g.r')).length).toBeGreaterThan(0);
});

test('pull paging', async () => {
  const reader = await as('pager', ['R']);
  await writer.send('g.r', enc('a'));
  await writer.send('g.r', enc('b'));
  const all = await reader.pull('g.r');
  const after = await reader.pull('g.r', { afterId: all[0].id, limit: 1 });
  expect(after).toEqual([all[1]]);
});

test('watch receives new messages', async () => {
  const got: Envelope[] = [];
  const stop = (await as('watcher', ['R'])).watch('g.r', e => got.push(e));
  await until(() => got.length > 0, 2000); // existing messages first
  const before = got.length;
  await writer.send('g.r', enc('new'));
  expect(await until(() => got.length === before + 1, 2000)).toBe(true);
  expect(new TextDecoder().decode(got.at(-1)!.payload)).toBe('new');
  stop();
});

test('expired session stops delivery', async () => {
  const reader = await as('shortlived', ['R'], 5);
  const got: Envelope[] = [];
  reader.watch('g.r', e => got.push(e));
  expect(await reader.closed).toBe('expired');
  await Bun.sleep(20_000); // past one sweep
  const before = got.length;
  await writer.send('g.r', enc('too late'));
  await Bun.sleep(1000);
  expect(got.length).toBe(before);
}, 40_000);

test('onExpired refresh reconnects watch', async () => {
  const reader = await as('refresher', ['R'], 5, () => env.tokenFor('refresher', ['R'], 3600));
  const got: Envelope[] = [];
  reader.watch('g.r', e => got.push(e));
  await Bun.sleep(7000); // past exp -> refresh -> reconnect
  await writer.send('g.r', enc('after refresh'));
  expect(await until(() => got.some(e => new TextDecoder().decode(e.payload) === 'after refresh'), 5000)).toBe(true);
}, 40_000);

test('topic lifetime deletes topic and messages', async () => {
  const alice = await as('alice2', ['T']);
  await alice.createTopic('g.short', { readPolicies: ['R'], writePolicies: ['W'], lifetimeSecs: 2 });
  await writer.send('g.short', enc('x'));
  expect((await alice.listTopics('g')).map(t => t.address)).toContain('g.short');
  await Bun.sleep(20_000);
  expect((await alice.listTopics('g')).map(t => t.address)).not.toContain('g.short');
}, 40_000);

test('send after topic expiry', async () => {
  await expect(writer.send('g.short', enc('x'))).rejects.toThrow('no such topic g.short');
});

test('pull on an unknown topic rejects', async () => {
  await expect((await as('reader2', ['R'])).pull('g.nope')).rejects.toThrow('no such topic g.nope');
});

test('watch on an unknown topic reports an error', async () => {
  const errs: Error[] = [];
  (await as('reader3', ['R'])).watch('g.nope', () => {}, e => errs.push(e));
  expect(await until(() => errs.length === 1, 3000)).toBe(true);
  expect(errs[0].message).toBe('no such topic g.nope');
});
