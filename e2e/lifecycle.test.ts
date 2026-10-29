import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect } from '../client/src';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(() => env?.teardown());

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, Bun.sleep(ms).then(() => { throw new Error(`still pending after ${ms}ms`); })]);

test('calls after the connection is gone reject instead of hanging', async () => {
  const c = await connect({ uri: env.uri, db: env.db, token: await env.tokenFor('alice', ['ONBOARDED']) });
  c.close();
  await expect(within(c.send('g.x', new Uint8Array(1)), 2000)).rejects.toThrow('connection closed');
  await expect(within(c.listTopics('g'), 2000)).rejects.toThrow('connection closed');
});

test('close() during a pending refresh does not leave a live connection behind', async () => {
  let calls = 0;
  let release!: (t: string) => void;
  const c = await connect({
    uri: env.uri, db: env.db, token: await env.tokenFor('carol', [], 2),
    onExpired: () => { calls++; return new Promise<string>(r => (release = r)); },
  });
  await Bun.sleep(2500); // expired, refresh pending
  expect(calls).toBe(1);
  const before = c.conn;
  c.close();
  release(await env.tokenFor('carol', [], 2));
  await Bun.sleep(3500); // a zombie would reconnect and hit expiry again
  expect(calls).toBe(1);
  expect(c.conn).toBe(before);
  expect(await c.closed).toBe('closed');
}, 20_000);
