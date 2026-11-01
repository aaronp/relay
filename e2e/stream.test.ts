import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type Client, type Envelope } from '../client/src';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
const open: Client[] = [];
const enc = (s: string) => new TextEncoder().encode(s);
const text = (e: Envelope) => `${e.group}.${e.topic}:${new TextDecoder().decode(e.payload)}`;

async function as(sub: string, saids: string[]) {
  const c = await connect({ uri: env.uri, db: env.db, token: await env.tokenFor(sub, saids) });
  open.push(c);
  return c;
}

const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (cond()) return true;
  return cond();
};

let owner: Client;
let writer: Client;
let topicN = 0;
/** A fresh topic readable with R, writable with W. */
async function topic(opts: { deletePolicies?: string[] } = {}) {
  const addr = `g.t${++topicN}`;
  await owner.createTopic(addr, { readPolicies: ['R'], writePolicies: ['W'], ...opts });
  return addr;
}

beforeAll(async () => {
  env = await setup();
  owner = await as('owner', ['ONBOARDED']);
  await owner.createGroup('g', { createTopicPolicies: [] });
  writer = await as('writer', ['W']);
});
afterAll(() => { for (const c of open) c.close(); env?.teardown(); });

test('one stream follows topics as they are added and removed', async () => {
  const [a, b] = [await topic(), await topic()];
  const got: string[] = [];
  const s = (await as('r1', ['R'])).stream(e => got.push(text(e)));

  s.add(a);
  await writer.send(a, enc('a1'));
  expect(await until(() => got.includes(`${a}:a1`))).toBe(true);
  await writer.send(b, enc('not yet'));

  s.add(b); // includes what b already holds
  expect(await until(() => got.includes(`${b}:not yet`))).toBe(true);
  expect(s.topics.sort()).toEqual([a, b].sort());

  s.remove(a);
  await writer.send(a, enc('dropped'));
  await writer.send(b, enc('b2'));
  expect(await until(() => got.includes(`${b}:b2`))).toBe(true);
  await Bun.sleep(300);
  expect(got).not.toContain(`${a}:dropped`);
  expect(s.topics).toEqual([b]);
  s.close();
});

test('existing messages arrive in id order, each once', async () => {
  const addr = await topic();
  for (const m of ['1', '2', '3', '4', '5']) await writer.send(addr, enc(m));
  const got: string[] = [];
  const s = (await as('r2', ['R'])).stream(e => got.push(text(e)));
  s.add(addr);
  s.add(addr); // a second add of the same topic changes nothing
  expect(await until(() => got.length >= 5)).toBe(true);
  await Bun.sleep(300);
  expect(got).toEqual(['1', '2', '3', '4', '5'].map(m => `${addr}:${m}`));
});

test("from 'now' skips history and delivers only new messages", async () => {
  const addr = await topic();
  await writer.send(addr, enc('old'));
  const got: string[] = [];
  const reader = await as('r3', ['R']);
  reader.stream(e => got.push(text(e))).add(addr, { from: 'now' });
  await reader.pull(addr); // lets the subscription settle before the next send
  await Bun.sleep(300);
  await writer.send(addr, enc('new'));
  expect(await until(() => got.length > 0)).toBe(true);
  expect(got).toEqual([`${addr}:new`]);
});

test('from an id resumes after that message', async () => {
  const addr = await topic();
  for (const m of ['1', '2', '3']) await writer.send(addr, enc(m));
  const reader = await as('r4', ['R']);
  const all = await reader.pull(addr);
  const got: string[] = [];
  reader.stream(e => got.push(text(e))).add(addr, { from: all[0].id });
  expect(await until(() => got.length >= 2)).toBe(true);
  await writer.send(addr, enc('4'));
  expect(await until(() => got.length >= 3)).toBe(true);
  expect(got).toEqual([`${addr}:2`, `${addr}:3`, `${addr}:4`]);
});

test('removing and immediately re-adding replays from the requested position', async () => {
  const addr = await topic();
  await writer.send(addr, enc('m'));
  const got: string[] = [];
  const s = (await as('r5', ['R'])).stream(e => got.push(text(e)));
  s.add(addr);
  expect(await until(() => got.length === 1)).toBe(true);
  s.remove(addr);
  s.add(addr); // the first subscription's rows may still be cached at this point
  expect(await until(() => got.length === 2)).toBe(true);
  expect(got).toEqual([`${addr}:m`, `${addr}:m`]);
});

test('two streams on one connection each get history and new messages', async () => {
  const addr = await topic();
  await writer.send(addr, enc('old'));
  const reader = await as('r6', ['R']);
  const [x, y]: string[][] = [[], []];
  reader.stream(e => x.push(text(e))).add(addr);
  expect(await until(() => x.length === 1)).toBe(true);
  reader.stream(e => y.push(text(e))).add(addr);
  expect(await until(() => y.length === 1)).toBe(true);
  await writer.send(addr, enc('new'));
  expect(await until(() => x.length === 2 && y.length === 2)).toBe(true);
});

test('adding a topic you cannot read reports an error and leaves the stream', async () => {
  const addr = await topic();
  await writer.send(addr, enc('secret'));
  const got: Envelope[] = [];
  const errs: [string, string][] = [];
  const s = (await as('r7', [])).stream(e => got.push(e), (err, a) => errs.push([err.message, a]));
  s.add(addr);
  expect(await until(() => errs.length === 1)).toBe(true);
  expect(errs[0]).toEqual([`no read access to ${addr}`, addr]);
  expect(got).toEqual([]);
  expect(s.topics).toEqual([]);
});

test('the topic owner can add a topic without holding its read policy', async () => {
  const addr = await topic();
  await writer.send(addr, enc('mine'));
  const got: string[] = [];
  owner.stream(e => got.push(text(e))).add(addr);
  expect(await until(() => got.length === 1)).toBe(true);
});

test('adding an unknown topic reports an error', async () => {
  const errs: string[] = [];
  const s = (await as('r8', ['R'])).stream(() => {}, e => errs.push(e.message));
  s.add('g.nope');
  expect(await until(() => errs.length === 1)).toBe(true);
  expect(errs[0]).toBe('no such topic g.nope');
  expect(s.topics).toEqual([]);
});

test('delete needs the delete policy; the write policy is not enough', async () => {
  const addr = await topic({ deletePolicies: ['D'] });
  await expect((await as('w2', ['W', 'R'])).deleteTopic(addr)).rejects.toThrow('delete_topic requires one of [D]');
  await (await as('d1', ['D'])).deleteTopic(addr);
  expect((await owner.listTopics('g')).map(t => t.address)).not.toContain(addr);
});

test('a topic with no delete policies is owner-only', async () => {
  const addr = await topic();
  expect((await owner.listTopics('g')).find(t => t.address === addr)?.deletePolicies).toEqual([]);
  await expect((await as('d2', ['D'])).deleteTopic(addr)).rejects.toThrow('delete_topic is not permitted');
  await owner.deleteTopic(addr);
  expect((await owner.listTopics('g')).map(t => t.address)).not.toContain(addr);
});

test('deleting an unknown topic rejects', async () => {
  await expect(owner.deleteTopic('g.nope')).rejects.toThrow('no such topic g.nope');
});

test('deleting a topic removes its messages and tells live listeners', async () => {
  const [addr, other] = [await topic(), await topic()];
  await writer.send(addr, enc('m'));
  await writer.send(other, enc('o'));
  const got: string[] = [];
  const errs: [string, string][] = [];
  const reader = await as('r9', ['R']);
  const s = reader.stream(e => got.push(text(e)), (err, a) => errs.push([err.message, a]));
  s.add(addr);
  s.add(other);
  expect(await until(() => got.length === 2)).toBe(true);

  await owner.deleteTopic(addr);
  expect(await until(() => errs.length === 1)).toBe(true);
  expect(errs[0]).toEqual([`topic ${addr} was removed`, addr]);
  expect(s.topics).toEqual([other]);

  // The address can be reused, and the new topic doesn't inherit the old messages.
  await owner.createTopic(addr, { readPolicies: ['R'], writePolicies: ['W'] });
  expect(await reader.pull(addr)).toEqual([]);
  await writer.send(other, enc('o2'));
  expect(await until(() => got.includes(`${other}:o2`))).toBe(true);
});

test('a listener is told when its topic expires', async () => {
  const addr = 'g.brief';
  await owner.createTopic(addr, { readPolicies: ['R'], writePolicies: ['W'], lifetimeSecs: 1 });
  const errs: string[] = [];
  (await as('r10', ['R'])).stream(() => {}, e => errs.push(e.message)).add(addr);
  expect(await until(() => errs.length === 1, 25_000)).toBe(true);
  expect(errs[0]).toBe(`topic ${addr} was removed`);
}, 30_000);

test('token refresh resumes the stream with no gaps or repeats', async () => {
  const [a, b] = [await topic(), await topic()];
  await writer.send(a, enc('old'));
  const reader = await connect({
    uri: env.uri, db: env.db, token: await env.tokenFor('r11', ['R'], 3),
    onExpired: async () => { await writer.send(a, enc('during')); return env.tokenFor('r11', ['R'], 3600); },
  });
  open.push(reader);
  const got: string[] = [];
  const s = reader.stream(e => got.push(text(e)));
  s.add(a);
  s.add(b, { from: 'now' });
  await until(() => got.length === 1);
  await Bun.sleep(100);
  await writer.send(b, enc('b-live'));
  expect(await until(() => got.includes(`${b}:b-live`))).toBe(true);

  await Bun.sleep(4000); // past exp -> refresh -> reconnect
  await writer.send(a, enc('after'));
  expect(await until(() => got.includes(`${a}:after`))).toBe(true);
  expect(got.filter(g => g.startsWith(a))).toEqual([`${a}:old`, `${a}:during`, `${a}:after`]);
  expect(got.filter(g => g.startsWith(b))).toEqual([`${b}:b-live`]);
}, 20_000);
