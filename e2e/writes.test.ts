import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type Client } from '../client/src';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
const clients = new Map<string, Client>();
beforeAll(async () => { env = await setup(); });
afterAll(() => { for (const c of clients.values()) c.close(); env?.teardown(); });

async function as(sub: string, saids: string[]) {
  if (!clients.has(sub)) clients.set(sub, await connect({ uri: env.uri, db: env.db, token: await env.tokenFor(sub, saids) }));
  return clients.get(sub)!;
}

test('create_group needs the onboarding policy', async () => {
  await expect((await as('mallory', [])).createGroup('g1', { createTopicPolicies: ['T'] }))
    .rejects.toThrow('create_group requires one of [ONBOARDED]');
  await (await as('alice', ['ONBOARDED'])).createGroup('g1', { createTopicPolicies: ['T'] });
});

test('duplicate group rejected', async () => {
  await expect((await as('alice', ['ONBOARDED'])).createGroup('g1', { createTopicPolicies: [] }))
    .rejects.toThrow('group "g1" already exists');
});

test('rejects bad names', async () => {
  const alice = await as('alice', ['ONBOARDED']);
  await expect(alice.createGroup('Bad.Name', { createTopicPolicies: [] })).rejects.toThrow('invalid name "Bad.Name"');
  await expect(alice.createTopic('g1.a.b', { readPolicies: [], writePolicies: [] })).rejects.toThrow('invalid name "g1.a.b"');
});

test('create_topic needs group policy; owner implicitly allowed', async () => {
  await (await as('bob', ['T'])).createTopic('g1.foo', { readPolicies: ['R'], writePolicies: ['W'] });
  await expect((await as('carol', [])).createTopic('g1.bar', { readPolicies: [], writePolicies: [] }))
    .rejects.toThrow('create_topic requires one of [T]');
  await (await as('alice', ['ONBOARDED'])).createTopic('g1.own', { readPolicies: [], writePolicies: [] });
  await expect((await as('bob', ['T'])).createTopic('g1.foo', { readPolicies: [], writePolicies: [] }))
    .rejects.toThrow('topic "g1.foo" already exists');
  await expect((await as('bob', ['T'])).createTopic('nope.foo', { readPolicies: [], writePolicies: [] }))
    .rejects.toThrow('no such group nope');
});

test('listTopics reports metadata', async () => {
  const topics = await (await as('carol', [])).listTopics('g1');
  expect(topics).toContainEqual(expect.objectContaining({
    address: 'g1.foo', name: 'foo', group: 'g1', owner: 'bob', readPolicies: ['R'], writePolicies: ['W'],
  }));
  expect(topics.map(t => t.address).sort()).toEqual(['g1.foo', 'g1.own']);
});

test('send needs write policy', async () => {
  await (await as('dave', ['W'])).send('g1.foo', new TextEncoder().encode('hi'));
  await expect((await as('erin', ['R'])).send('g1.foo', new TextEncoder().encode('hi')))
    .rejects.toThrow('send requires one of [W]');
});

test('payload size limits', async () => {
  const dave = await as('dave', ['W']);
  await dave.send('g1.foo', new Uint8Array(0));
  await dave.send('g1.foo', new Uint8Array(65536));
  await expect(dave.send('g1.foo', new Uint8Array(65537))).rejects.toThrow('payload too large (65537 > 65536 bytes)');
});

test('send to unknown topic', async () => {
  await expect((await as('dave', ['W'])).send('g1.nope', new Uint8Array(1))).rejects.toThrow('no such topic g1.nope');
});
