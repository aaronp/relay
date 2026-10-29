import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect } from '../client/src';
import { startDevIssuer } from '../dev-issuer/src/issuer';
import { setup } from './harness';

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(() => env?.teardown());

test('valid dev token connects and session captures claims', async () => {
  const c = await connect({ uri: env.uri, db: env.db, token: await env.tokenFor('alice', ['ONBOARDED', 'X']) });
  try {
    const rows = await new Promise<any[]>((resolve, reject) => {
      c.conn.subscriptionBuilder()
        .onApplied(() => resolve([...c.conn.db.mySession.iter()]))
        .onError(ctx => reject(ctx.event))
        .subscribe('SELECT * FROM my_session');
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('alice');
    expect(rows[0].policySaids).toEqual(['ONBOARDED', 'X']);
  } finally {
    c.close();
  }
});

test('expired token is rejected', async () => {
  await expect(connect({ uri: env.uri, db: env.db, token: await env.tokenFor('bob', [], -10) })).rejects.toThrow();
});

test('token from untrusted issuer is rejected', async () => {
  const other = await startDevIssuer({ port: 7899 });
  try {
    const token = await other.mint({ sub: 'eve', saids: ['ONBOARDED'], ttlSec: 3600 });
    await expect(connect({ uri: env.uri, db: env.db, token })).rejects.toThrow();
  } finally {
    other.stop();
  }
});
