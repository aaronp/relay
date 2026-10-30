// OAuth auth-code + PKCE (S256) via a fixed loopback port. kerits treats the origin (port included) as
// the client_id, so the port must stay the same between runs for refresh tokens to keep working.
import {
  authorizeUrl, createPkce, discover, exchangeCode, parseCallback, refreshTokens, type Tokens,
} from '@aaronp/relay-client';
import type { Config } from './config';

const clientId = (cfg: Config) => `http://127.0.0.1:${cfg.port}`;

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  try { Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }); } catch {}
}

export async function login(cfg: Config): Promise<Tokens> {
  const ep = await discover(cfg.issuer);
  const pkce = await createPkce();
  const redirectUri = `${clientId(cfg)}/callback`;

  let done!: (code: string) => void;
  let fail!: (e: Error) => void;
  const codeP = new Promise<string>((res, rej) => { done = res; fail = rej; });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    fetch(req) {
      if (new URL(req.url).pathname !== '/callback') return new Response('not found', { status: 404 });
      try {
        done(parseCallback(req.url, pkce).code);
        return new Response('Authenticated. You can close this tab.');
      } catch (e) {
        fail(e as Error);
        return new Response('Authentication failed. You can close this tab.');
      }
    },
  });

  const auth = authorizeUrl(ep, { clientId: clientId(cfg), redirectUri, pkce });
  console.error(`Opening your wallet to sign in. If nothing opens, visit:\n${auth}`);
  openBrowser(auth);
  try {
    return await exchangeCode(ep, { code: await codeP, clientId: clientId(cfg), redirectUri, verifier: pkce.verifier });
  } finally {
    server.stop(true);
  }
}

/** New token via the stored refresh token, or undefined if there is none / it was refused. */
export async function refresh(cfg: Config): Promise<Tokens | undefined> {
  if (!cfg.refreshToken) return undefined;
  try {
    return await refreshTokens(await discover(cfg.issuer), { refreshToken: cfg.refreshToken, clientId: clientId(cfg) });
  } catch {
    return undefined;
  }
}
