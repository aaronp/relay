// OAuth auth-code + PKCE (S256) building blocks. Browser-safe: fetch, crypto, atob/btoa, URL only.
// kerits treats the app's origin (port included) as its client_id; redirect_uri must share that origin.
import { claimValue, decodePayload } from './jwt';

export type Pkce = { verifier: string; challenge: string; state: string };
export type Endpoints = { authorization_endpoint: string; token_endpoint: string };
export type Tokens = { token: string; refreshToken?: string };
type TokenResponse = {
  id_token?: string; access_token?: string; refresh_token?: string; error?: string; error_description?: string;
};

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function createPkce(): Promise<Pkce> {
  const verifier = random(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge, state: random(16) };
}

export async function discover(issuer: string): Promise<Endpoints> {
  const r = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${r.status}`);
  return r.json();
}

export function authorizeUrl(ep: Endpoints, p: { clientId: string; redirectUri: string; pkce: Pkce }): string {
  const u = new URL(ep.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, scope: 'openid',
    state: p.pkce.state, code_challenge: p.pkce.challenge, code_challenge_method: 'S256',
  })) u.searchParams.set(k, v);
  return u.toString();
}

export function parseCallback(url: string, pending: { state: string } | null): { code: string } {
  if (!pending) throw new Error('login state missing — click Authenticate again');
  const q = new URL(url).searchParams;
  const err = q.get('error');
  if (err) {
    const desc = q.get('error_description');
    throw new Error(`authorization failed: ${err}${desc ? ` — ${desc}` : ''}`);
  }
  if (q.get('state') !== pending.state) throw new Error('state mismatch');
  const code = q.get('code');
  if (!code) throw new Error('no authorization code in callback');
  return { code };
}

const hasClaim = (jwt: string | undefined, claimKey: string) => {
  try { return !!jwt && claimValue(decodePayload(jwt), claimKey) !== undefined; } catch { return false; }
};

/** Whichever token carries the policy claim; else the ID token (SpacetimeDB wants an OIDC ID token). */
export function pickToken(t: { id_token?: string; access_token?: string }, claimKey = 'kerits.policySAIDs'): string {
  const token = hasClaim(t.id_token, claimKey) ? t.id_token
    : hasClaim(t.access_token, claimKey) ? t.access_token
    : t.id_token;
  if (!token) throw new Error('token endpoint returned no id_token');
  return token;
}

async function tokenRequest(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const t: TokenResponse = await r.json().catch(() => ({}));
  if (t.error) throw new Error(`token endpoint: ${t.error}${t.error_description ? ` — ${t.error_description}` : ''}`);
  if (!r.ok) throw new Error(`token endpoint: HTTP ${r.status}`);
  return t;
}

export async function exchangeCode(
  ep: Endpoints, p: { code: string; clientId: string; redirectUri: string; verifier: string }
): Promise<Tokens> {
  const t = await tokenRequest(ep.token_endpoint, {
    grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri,
    client_id: p.clientId, code_verifier: p.verifier,
  });
  return { token: pickToken(t), refreshToken: t.refresh_token };
}

export async function refreshTokens(ep: Endpoints, p: { refreshToken: string; clientId: string }): Promise<Tokens> {
  const t = await tokenRequest(ep.token_endpoint, {
    grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId,
  });
  return { token: pickToken(t), refreshToken: t.refresh_token ?? p.refreshToken };
}
