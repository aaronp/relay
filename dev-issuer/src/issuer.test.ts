import { expect, test } from 'bun:test';
import { startDevIssuer } from './issuer';

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

test('mints ES256 tokens verifiable against its JWKS', async () => {
  const iss = await startDevIssuer({ port: 7866 });
  try {
    const token = await iss.mint({ sub: 'alice', saids: ['A'], ttlSec: 60 });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    expect(payload.iss).toBe(iss.issuer);
    expect(payload.sub).toBe('alice');
    expect(payload['kerits.policySAIDs']).toEqual(['A']);
    expect(payload.exp - payload.iat).toBe(60);

    const disco = await (await fetch(`${iss.issuer}/.well-known/openid-configuration`)).json();
    const { keys } = await (await fetch(disco.jwks_uri)).json();
    const key = await crypto.subtle.importKey('jwk', keys[0], { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, b64url(s), new TextEncoder().encode(`${h}.${p}`)
    );
    expect(ok).toBe(true);
  } finally {
    iss.stop();
  }
});
