// Local OIDC-ish issuer for tests and dev: discovery + JWKS + mint(). Not for production.

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === 'string' ? b : String.fromCharCode(...b))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export type MintClaims = { sub: string; saids: string[]; ttlSec: number; claimKey?: string };

export async function startDevIssuer(opts: { port: number }) {
  const issuer = `http://127.0.0.1:${opts.port}`;
  const kid = 'dev-1';
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid, alg: 'ES256', use: 'sig' };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      // GET /mint?sub=alice&saids=A,B&ttl=3600 -> token (dev convenience for the CLI)
      if (path === '/mint') {
        const q = url.searchParams;
        return new Response(await mint({
          sub: q.get('sub') ?? 'dev',
          saids: (q.get('saids') ?? '').split(',').filter(Boolean),
          ttlSec: Number(q.get('ttl') ?? 3600),
        }));
      }
      if (path === '/.well-known/openid-configuration')
        return Response.json({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ['ES256'],
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
        });
      if (path === '/jwks') return Response.json({ keys: [jwk] });
      return new Response('not found', { status: 404 });
    },
  });

  async function mint(c: MintClaims): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
    const payload = b64url(JSON.stringify({
      iss: issuer, sub: c.sub, aud: 'topics-dev', iat, exp: iat + c.ttlSec,
      [c.claimKey ?? 'kerits.policySAIDs']: c.saids,
    }));
    // WebCrypto ECDSA signatures are already raw r||s, which is what JWS ES256 wants.
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(`${header}.${payload}`)
    );
    return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  }

  return { issuer, mint, stop: () => server.stop(true) };
}
