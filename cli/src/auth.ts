// OAuth auth-code + PKCE (S256) via a fixed loopback port. kerits treats the origin (port included) as
// the client_id, so the port must stay the same between runs for refresh tokens to keep working.
import type { Config } from './config';

const b64url = (b: Uint8Array) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Endpoints = { authorization_endpoint: string; token_endpoint: string };
type TokenResponse = { id_token?: string; access_token?: string; refresh_token?: string; error?: string; error_description?: string };

const clientId = (cfg: Config) => `http://127.0.0.1:${cfg.port}`;

async function discover(issuer: string): Promise<Endpoints> {
  const r = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${r.status}`);
  return r.json();
}

const hasPolicyClaim = (jwt?: string) => {
  try {
    const p = JSON.parse(atob(jwt!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return 'kerits.policySAIDs' in p || !!p.kerits?.policySAIDs;
  } catch { return false; }
};

/** Prefer whichever token carries the policy claim; default to the ID token (SpacetimeDB wants an OIDC ID token). */
function pickToken(t: TokenResponse): string {
  if (t.error) throw new Error(`token endpoint: ${t.error}${t.error_description ? ` — ${t.error_description}` : ''}`);
  const token = hasPolicyClaim(t.id_token) ? t.id_token : hasPolicyClaim(t.access_token) ? t.access_token : t.id_token;
  if (!token) throw new Error('token endpoint returned no id_token');
  return token;
}

async function tokenRequest(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return r.json();
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  try { Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }); } catch {}
}

export async function login(cfg: Config): Promise<{ token: string; refreshToken?: string }> {
  const ep = await discover(cfg.issuer);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = `${clientId(cfg)}/callback`;

  let done!: (code: string) => void;
  let fail!: (e: Error) => void;
  const codeP = new Promise<string>((res, rej) => { done = res; fail = rej; });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== '/callback') return new Response('not found', { status: 404 });
      const err = u.searchParams.get('error');
      if (err) fail(new Error(`authorization failed: ${err}`));
      else if (u.searchParams.get('state') !== state) fail(new Error('state mismatch'));
      else done(u.searchParams.get('code') ?? '');
      return new Response(err ? 'Authentication failed. You can close this tab.' : 'Authenticated. You can close this tab.');
    },
  });

  const auth = new URL(ep.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId(cfg), redirect_uri: redirectUri, scope: 'openid',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })) auth.searchParams.set(k, v);

  console.error(`Opening your wallet to sign in. If nothing opens, visit:\n${auth}`);
  openBrowser(auth.toString());
  try {
    const code = await codeP;
    const t = await tokenRequest(ep.token_endpoint, {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId(cfg), code_verifier: verifier,
    });
    return { token: pickToken(t), refreshToken: t.refresh_token };
  } finally {
    server.stop(true);
  }
}

/** New token via the stored refresh token, or undefined if there is none / it was refused. */
export async function refresh(cfg: Config): Promise<{ token: string; refreshToken?: string } | undefined> {
  if (!cfg.refreshToken) return undefined;
  try {
    const ep = await discover(cfg.issuer);
    const t = await tokenRequest(ep.token_endpoint, {
      grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: clientId(cfg),
    });
    return { token: pickToken(t), refreshToken: t.refresh_token ?? cfg.refreshToken };
  } catch {
    return undefined;
  }
}
