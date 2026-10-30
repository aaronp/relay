// Settings + tokens in localStorage (dev tool), pending PKCE state in sessionStorage across the redirect.
import {
  authorizeUrl, createPkce, decodeExp, discover, exchangeCode, parseCallback, refreshTokens, type Tokens,
} from '@topics/client';

export type Settings = { walletUrl: string; server: string; db: string };

/** kerits uses the origin as client_id, so the UI must always run here. */
export const EXPECTED_ORIGIN = 'http://127.0.0.1:5173';
const clientId = () => window.location.origin;
const redirectUri = () => `${clientId()}/callback`;
const MIN_VALIDITY_MS = 30_000; // don't connect with a token that's about to lapse
const KEY = 'topics-web';
const PENDING = 'topics-web-pending';

const DEFAULTS: Settings = { walletUrl: 'https://oauth.kerits.id', server: 'ws://127.0.0.1:3010', db: 'relay' };

type Stored = { settings?: Partial<Settings>; tokens?: Tokens | null };
type Pending = { verifier: string; state: string; walletUrl: string };

function read(): Stored {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}
function write(patch: Stored) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch })); } catch {}
}

export const loadSettings = (): Settings => ({ ...DEFAULTS, ...read().settings });
export const saveSettings = (settings: Settings) => write({ settings });
export const loadTokens = (): Tokens | null => read().tokens ?? null;
export const saveTokens = (tokens: Tokens | null) => write({ tokens });

export async function beginLogin(s: Settings): Promise<void> {
  if (clientId() !== EXPECTED_ORIGIN)
    throw new Error(`open the UI at ${EXPECTED_ORIGIN} (kerits needs a stable origin)`);
  const ep = await discover(s.walletUrl);
  const pkce = await createPkce();
  const pending: Pending = { verifier: pkce.verifier, state: pkce.state, walletUrl: s.walletUrl };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  window.location.assign(authorizeUrl(ep, { clientId: clientId(), redirectUri: redirectUri(), pkce }));
}

/** Finish the redirect: validates state, exchanges the code, stores tokens, and returns the URL to `/`. */
export async function completeLogin(url: string): Promise<Tokens> {
  let pending: Pending | null = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null'); } catch {}
  sessionStorage.removeItem(PENDING);
  window.history.replaceState({}, '', '/');
  const { code } = parseCallback(url, pending);
  const ep = await discover(pending!.walletUrl);
  const tokens = await exchangeCode(ep, {
    code, clientId: clientId(), redirectUri: redirectUri(), verifier: pending!.verifier,
  });
  saveTokens(tokens);
  return tokens;
}

export type RefreshResult = { tokens: Tokens } | { error: string };

/** New tokens via the refresh token; on failure, the reason (shown to the user, never swallowed). */
export async function refresh(s: Settings, tokens: Tokens | null): Promise<RefreshResult> {
  if (!tokens?.refreshToken) return { error: 'no refresh token' };
  try {
    const next = await refreshTokens(await discover(s.walletUrl), { refreshToken: tokens.refreshToken, clientId: clientId() });
    saveTokens(next);
    return { tokens: next };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Tokens good for at least 30s: the given ones, or refreshed ones (e.g. after a reload). Throws with the reason. */
export async function usableTokens(s: Settings, tokens: Tokens, now = Date.now()): Promise<Tokens> {
  let valid = false;
  try { valid = decodeExp(tokens.token) * 1000 - now > MIN_VALIDITY_MS; } catch {}
  if (valid) return tokens;
  const r = await refresh(s, tokens);
  if ('error' in r) throw new Error(`token expired (refresh failed: ${r.error})`);
  return r.tokens;
}
