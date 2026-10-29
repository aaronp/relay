import { afterEach, expect, test } from 'bun:test';

// session.ts reads window.location.origin lazily; bun has no window.
(globalThis as any).window = { location: { origin: 'http://127.0.0.1:5173' } };
const { refresh, usableTokens } = await import('./session');

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ sub: 'a', exp })).toString('base64url')}.s`;
const now = 1_000_000_000_000;
const settings = { walletUrl: 'https://w', server: 'ws://s', db: 'd' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubWallet(tokenBody: object, status = 200) {
  globalThis.fetch = (async (url: string) => String(url).endsWith('/.well-known/openid-configuration')
    ? Response.json({ authorization_endpoint: 'https://w/authorize', token_endpoint: 'https://w/token' })
    : Response.json(tokenBody, { status })) as any;
}

test('usableTokens keeps a token with time left', async () => {
  const t = { token: jwt(now / 1000 + 3600), refreshToken: 'r' };
  globalThis.fetch = (() => { throw new Error('should not fetch'); }) as any;
  expect(await usableTokens(settings, t, now)).toBe(t);
});

test('usableTokens refreshes an expired token (e.g. after a reload)', async () => {
  const fresh = jwt(now / 1000 + 3600);
  stubWallet({ id_token: fresh, refresh_token: 'r2' });
  expect(await usableTokens(settings, { token: jwt(now / 1000 - 10), refreshToken: 'r' }, now))
    .toEqual({ token: fresh, refreshToken: 'r2' });
});

test('refresh failure keeps the reason', async () => {
  stubWallet({ error: 'invalid_grant' }, 400);
  expect(await refresh(settings, { token: jwt(0), refreshToken: 'r' })).toEqual({ error: 'token endpoint: invalid_grant' });
  await expect(usableTokens(settings, { token: jwt(now / 1000 - 10), refreshToken: 'r' }, now))
    .rejects.toThrow('token expired (refresh failed: token endpoint: invalid_grant)');
  expect(await refresh(settings, { token: jwt(0) })).toEqual({ error: 'no refresh token' });
});
