import { expect, test } from 'bun:test';
import { decodeClaims } from './jwt';
import { authorizeUrl, createPkce, parseCallback, pickToken } from './oauth';

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('createPkce challenge is S256 of verifier', async () => {
  const p = await createPkce();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.verifier)));
  expect(p.challenge).toBe(Buffer.from(h).toString('base64url'));
  expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('authorizeUrl carries PKCE and client params', async () => {
  const pkce = await createPkce();
  const u = new URL(authorizeUrl({ authorization_endpoint: 'https://w/authorize', token_endpoint: '' },
    { clientId: 'http://127.0.0.1:5173', redirectUri: 'http://127.0.0.1:5173/callback', pkce }));
  expect(Object.fromEntries(u.searchParams)).toMatchObject({
    response_type: 'code', client_id: 'http://127.0.0.1:5173', redirect_uri: 'http://127.0.0.1:5173/callback',
    scope: 'openid', state: pkce.state, code_challenge: pkce.challenge, code_challenge_method: 'S256',
  });
});

test('parseCallback', () => {
  const cb = 'http://127.0.0.1:5173/callback';
  expect(parseCallback(`${cb}?code=C&state=S`, { state: 'S' })).toEqual({ code: 'C' });
  expect(() => parseCallback(`${cb}?code=C&state=S`, null)).toThrow('login state missing — click Authenticate again');
  expect(() => parseCallback(`${cb}?error=access_denied&error_description=nope&state=S`, { state: 'S' }))
    .toThrow('authorization failed: access_denied — nope');
  expect(() => parseCallback(`${cb}?code=C&state=X`, { state: 'S' })).toThrow('state mismatch');
  expect(() => parseCallback(`${cb}?state=S`, { state: 'S' })).toThrow('no authorization code in callback');
});

test('pickToken prefers the token carrying the claim', () => {
  const plain = jwt({ sub: 'a' });
  const withClaim = jwt({ sub: 'a', 'kerits.policySAIDs': ['X'] });
  expect(pickToken({ id_token: plain, access_token: withClaim })).toBe(withClaim);
  expect(pickToken({ id_token: withClaim, access_token: plain })).toBe(withClaim);
  expect(pickToken({ id_token: plain, access_token: plain })).toBe(plain);
  expect(() => pickToken({ access_token: plain })).toThrow();
});

test('decodeClaims', () => {
  expect(decodeClaims(jwt({ sub: 'a', exp: 9, 'kerits.policySAIDs': ['X', 3] }))).toEqual({ sub: 'a', saids: ['X'], exp: 9 });
  expect(decodeClaims(jwt({ sub: 'b', exp: 1, kerits: { policySAIDs: ['Y'] } }))).toEqual({ sub: 'b', saids: ['Y'], exp: 1 });
  expect(decodeClaims(jwt({ sub: 'c', exp: 1 }))).toEqual({ sub: 'c', saids: [], exp: 1 });
});
