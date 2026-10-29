// Settings + tokens in localStorage (dev tool), pending PKCE state in sessionStorage across the redirect.
import {
  authorizeUrl, createPkce, discover, exchangeCode, parseCallback, refreshTokens, type Tokens,
} from '@topics/client';

export type Settings = { walletUrl: string; server: string; db: string };

/** kerits uses the origin as client_id, so the UI must always run here. */
export const EXPECTED_ORIGIN = 'http://127.0.0.1:5173';
const CLIENT_ID = window.location.origin;
const REDIRECT_URI = `${CLIENT_ID}/callback`;
const KEY = 'topics-web';
const PENDING = 'topics-web-pending';

const DEFAULTS: Settings = { walletUrl: 'https://oauth.kerits.id', server: 'ws://127.0.0.1:3010', db: 'topics' };

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
  if (CLIENT_ID !== EXPECTED_ORIGIN)
    throw new Error(`open the UI at ${EXPECTED_ORIGIN} (kerits needs a stable origin)`);
  const ep = await discover(s.walletUrl);
  const pkce = await createPkce();
  const pending: Pending = { verifier: pkce.verifier, state: pkce.state, walletUrl: s.walletUrl };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  window.location.assign(authorizeUrl(ep, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, pkce }));
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
    code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, verifier: pending!.verifier,
  });
  saveTokens(tokens);
  return tokens;
}

/** New tokens via the refresh token, or undefined if there is none or it was refused. */
export async function refresh(s: Settings, tokens: Tokens | null): Promise<Tokens | undefined> {
  if (!tokens?.refreshToken) return undefined;
  try {
    const next = await refreshTokens(await discover(s.walletUrl), { refreshToken: tokens.refreshToken, clientId: CLIENT_ID });
    saveTokens(next);
    return next;
  } catch {
    return undefined;
  }
}
