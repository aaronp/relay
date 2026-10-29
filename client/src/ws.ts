// The SDK's default socket swaps our JWT for a SpacetimeDB "websocket token", which keeps custom
// claims but rewrites iat/exp (exp = now + 60s). The module needs the real exp to cut readers off,
// so we send the original token and skip the exchange: as an Authorization header where the runtime
// allows it (Bun/Node), otherwise (browsers) as ?token= on the URL — which can land in proxy logs.
// Compression is forced to None; frames then carry a 1-byte tag (0) we strip, like the SDK adapter.
import type { DbConnectionBuilder } from 'spacetimedb';

type WSFn = Parameters<DbConnectionBuilder<any>['withWSFn']>[0];
type Args = Parameters<WSFn>[0];

/** Browsers can't set websocket headers. */
export const tokenGoesInUrl = () => typeof document !== 'undefined';

export function subscribeUrl(args: Args, tokenInUrl: boolean): URL {
  const u = new URL(`v1/database/${args.nameOrAddress}/subscribe`, args.url);
  if (tokenInUrl && args.authToken) u.searchParams.set('token', args.authToken);
  u.searchParams.set('compression', 'None');
  if (args.lightMode) u.searchParams.set('light', 'true');
  if (args.confirmedReads !== undefined) u.searchParams.set('confirmed', String(args.confirmedReads));
  if (args.connectionId) u.searchParams.set('connection_id', args.connectionId);
  if (args.sessionId) u.searchParams.set('session_id', args.sessionId);
  return u;
}

// ponytail: uses the global WebSocket (browsers, Bun, Node >= 22); pass a polyfill global for older Node.
export const directTokenSocket: WSFn = async (args: Args) => {
  const inUrl = tokenGoesInUrl();
  const url = subscribeUrl(args, inUrl).toString();
  const ws = inUrl || !args.authToken
    ? new WebSocket(url, args.wsProtocol)
    // Bun and Node (undici) accept { protocols, headers }; not part of the DOM typings.
    : new WebSocket(url, { protocols: args.wsProtocol, headers: { Authorization: `Bearer ${args.authToken}` } } as any);
  ws.binaryType = 'arraybuffer';
  return {
    get protocol() { return ws.protocol; },
    get readyState() { return ws.readyState; },
    send: (msg: Uint8Array) => ws.send(msg),
    close: () => ws.close(),
    set onclose(h: (ev: CloseEvent) => void) { ws.onclose = h; },
    set onopen(h: () => void) { ws.onopen = h; },
    set onerror(h: (ev: ErrorEvent) => void) { ws.onerror = h as any; },
    set onmessage(h: (m: { data: Uint8Array }) => void) {
      ws.onmessage = ev => {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        if (buf[0] !== 0) { ws.close(); return; } // only uncompressed frames expected
        h({ data: buf.subarray(1) });
      };
    },
  };
};
