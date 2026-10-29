# Web Reference UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Vite + React three-pane web app that signs in with a real kerits wallet and exercises every `@topics/client` operation, with every parameter and error visible.

**Architecture:**
- Browser-safe OAuth/PKCE and claim helpers move into `@topics/client` (`oauth.ts`, `jwt.ts`). The web app and the CLI share them, and future web apps can reuse them.
- Two silent-failure gaps in the library get fixed first.
- `web/` is a thin React shell: plain hooks state, plain CSS, and calls to `@topics/client` only.

**Tech Stack:** Vite 5.4, React 18.3, `@vitejs/plugin-react` 4.3, TypeScript, Bun (workspaces, `bun test`), existing `@topics/client` + SpacetimeDB 2.12.

**Spec:** `docs/superpowers/specs/2026-10-29-web-reference-ui-design.md` (builds on `docs/superpowers/specs/2026-10-29-topics-design.md`)

## Global Constraints

- Origin is fixed at `http://127.0.0.1:5173` (Vite `server.host: '127.0.0.1'`, `port: 5173`, `strictPort: true`), never `localhost`.
- `client_id = http://127.0.0.1:5173`, `redirect_uri = http://127.0.0.1:5173/callback`. PKCE is S256 only, scope `openid`, no client secret.
- Default wallet server is `https://oauth.kerits.id`, default SpacetimeDB is `ws://127.0.0.1:3010`, default db is `topics`.
- The browser calls kerits directly (CORS verified for discovery GET and `/token` POST). No proxy.
- Settings and the refresh token go in `localStorage` under the key `topics-web`. The PKCE verifier and state go in `sessionStorage` under `topics-web-pending` and are deleted after the callback.
- `web/` imports only `@topics/client` (plus react). There must be no server or policy logic in the UI beyond display helpers.
- Errors are shown verbatim, inline, next to the action that caused them. Never swallow them.
- `client/src/**` stays browser-safe: the existing `client/src/browser-safe.test.ts` must still pass.
- Dependency versions: `vite@5.4.11`, `react@18.3.1`, `react-dom@18.3.1`, `@vitejs/plugin-react@4.3.4`, `@types/react@18.3.12`, `@types/react-dom@18.3.1`.

## Review Focus

1. **The callback arrives with `error=...` or a mismatched `state`:** show the error and store no token. Test: Task 2 `parseCallback` cases.
2. **The page reloads between redirect and callback, so the pending PKCE state is missing:** show "login state missing — click Authenticate again". Test: Task 2 `parseCallback` with `pending = null`.
3. **SAID input with spaces or empty entries (`" A, ,B ,"`):** gives `['A','B']`. Test: Task 3 `parseSaids`.
4. **A payload that isn't valid UTF-8:** shown as `hex:` plus lowercase hex, never mojibake. Test: Task 3 `displayPayload`.
5. **The token expires while streaming:** the stream stops visibly. The UI tries a refresh, and on failure shows "signed out". Covered by the existing library e2e `onExpired refresh reconnects watch`, plus a manual check in Task 4 Step 6.

---

## File Structure

```
client/src/oauth.ts          # browser-safe PKCE: createPkce, authorizeUrl, parseCallback, discover, exchangeCode, refreshTokens, pickToken
client/src/oauth.test.ts
client/src/jwt.ts            # + decodeClaims(token, claimKey?) -> { sub, saids, exp }
client/src/access.ts         # topicAccess(claims, topic) -> { read, write }
client/src/access.test.ts
client/src/index.ts          # watch onError; pull rejects unknown topic; re-exports
cli/src/auth.ts              # refactored onto client/src/oauth.ts (loopback server stays here)
e2e/reads.test.ts            # + unknown-topic tests
web/
  package.json  vite.config.ts  tsconfig.json  index.html
  src/main.tsx               # mounts <App/>
  src/App.tsx                # three panes, owns session + client state, handles /callback
  src/session.ts             # localStorage settings/tokens, sessionStorage pending login, login/refresh orchestration
  src/format.ts              # parseSaids, displayPayload, formatLifetime-free helpers
  src/format.test.ts
  src/ConnectionPane.tsx  src/TopicsPane.tsx  src/TopicPane.tsx
  src/styles.css
Makefile                     # + web
README.md                    # + Web UI section
```

---

### Task 1: Library: no silent failures in `watch` / `pull`

**Files:**
- Modify: `client/src/index.ts` (`pull` ~line 132, `watch` ~line 145, `#subscribeWatch` ~line 178)
- Test: `e2e/reads.test.ts`

**Interfaces:**
- Produces:
  - `Client.watch(addr: string, onMessage: (e: Envelope) => void, onError?: (err: Error) => void): () => void`. `onError` is called once with `new Error('no such topic <addr>')` when the topic doesn't exist. It is also called with the subscription's error if subscribing fails (`.onError` on the subscription builder) and if the topic lookup rejects.
  - `Client.pull(addr, opts?)` rejects with `no such topic <addr>` when the topic doesn't exist. An existing topic with no readable messages still resolves `[]`.
  - The same `onError` is used again when watches resubscribe after a token refresh.

- [ ] **Step 1: Add the failing tests** to `e2e/reads.test.ts`:

```ts
test('pull on an unknown topic rejects', async () => {
  await expect((await as('reader2', ['R'])).pull('g.nope')).rejects.toThrow('no such topic g.nope');
});
test('watch on an unknown topic reports an error', async () => {
  const errs: Error[] = [];
  (await as('reader3', ['R'])).watch('g.nope', () => {}, e => errs.push(e));
  expect(await until(() => errs.length === 1, 3000)).toBe(true);
  expect(errs[0].message).toBe('no such topic g.nope');
});
```

- [ ] **Step 2: Run** `bun test --timeout 60000 e2e/reads.test.ts`. Expected: these two FAIL, and the others pass.
- [ ] **Step 3: Implement** the Interfaces above in `client/src/index.ts`. Store `onError` on the `Watch` record.
- [ ] **Step 4: Run** `bun test --timeout 60000 ./e2e`. Expected: all PASS.
- [ ] **Step 5: Commit** `fix(client): watch reports errors; pull rejects unknown topic`.

---

### Task 2: Browser-safe OAuth helpers in `@topics/client`; CLI uses them

**Files:**
- Create: `client/src/oauth.ts`, `client/src/oauth.test.ts`
- Modify: `client/src/jwt.ts`, `client/src/index.ts` (re-export), `cli/src/auth.ts`

**Interfaces:**
- Produces (in `client/src/oauth.ts`, exported from `@topics/client`). Uses only `fetch`, `crypto`, `btoa`/`atob`, `URL`, `TextEncoder`:
  - `type Pkce = { verifier: string; challenge: string; state: string }`
  - `createPkce(): Promise<Pkce>`. The verifier and state are base64url of 32 and 16 random bytes. `challenge = base64url(SHA-256(verifier))`.
  - `type Endpoints = { authorization_endpoint: string; token_endpoint: string }`
  - `discover(issuer: string): Promise<Endpoints>`. It throws `OIDC discovery failed for <issuer>: <status>` on a non-OK response.
  - `authorizeUrl(ep: Endpoints, p: { clientId: string; redirectUri: string; pkce: Pkce }): string`. It sets `response_type=code`, `client_id`, `redirect_uri`, `scope=openid`, `state`, `code_challenge`, and `code_challenge_method=S256`.
  - `parseCallback(url: string, pending: { state: string } | null): { code: string }`. It throws, in this order:
    - `login state missing — click Authenticate again` when `pending` is null
    - `authorization failed: <error>[ — <error_description>]` when `error` is present
    - `state mismatch` when the state differs
    - `no authorization code in callback` when `code` is missing
  - `type Tokens = { token: string; refreshToken?: string }`
  - `exchangeCode(ep: Endpoints, p: { code: string; clientId: string; redirectUri: string; verifier: string }): Promise<Tokens>`
  - `refreshTokens(ep: Endpoints, p: { refreshToken: string; clientId: string }): Promise<Tokens>`. It keeps the old refresh token if none is returned.
  - Both POST `application/x-www-form-urlencoded`. On a non-OK status or an `error` body they throw `token endpoint: <error>[ — <desc>]` (or `token endpoint: HTTP <status>`).
  - `pickToken(t: { id_token?: string; access_token?: string }, claimKey = 'kerits.policySAIDs'): string`. It moves from `cli/src/auth.ts` and keeps the same rule: whichever token carries the claim (flat or nested), otherwise `id_token`, and it throws if there is none.
- Produces (in `client/src/jwt.ts`): `decodeClaims(token: string, claimKey = 'kerits.policySAIDs'): { sub: string; saids: string[]; exp: number }`. It reuses `readPolicySaids` semantics (flat key, then dotted path; non-strings dropped). Keep a local copy: client must not import module code.
- `cli/src/auth.ts` keeps its loopback `Bun.serve` and browser opening. It replaces its own discovery, PKCE, token request and `pickToken` with the functions above. The exported `login(cfg)` and `refresh(cfg)` signatures don't change.

- [ ] **Step 1: Write `client/src/oauth.test.ts`:**

```ts
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
    scope: 'openid', state: pkce.state, code_challenge: pkce.challenge, code_challenge_method: 'S256' });
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
test('pickToken prefers the token carrying the claim', () => { /* id_token without claim + access_token with -> access_token; neither -> id_token; none -> throws */ });
test('decodeClaims', () => { /* flat and nested claim, missing -> [] ; sub and exp read */ });
```

Build test JWTs as `header.base64url(JSON).sig`. No signature is needed.

- [ ] **Step 2: Run** `bun test ./client/src/oauth.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `oauth.ts` and `decodeClaims`, and re-export from `client/src/index.ts`.
- [ ] **Step 4: Refactor** `cli/src/auth.ts` onto these helpers.
- [ ] **Step 5: Run** `bun run test && bun test --timeout 60000 e2e/cli.test.ts`. Expected: all PASS. This includes `browser-safe.test.ts`.
- [ ] **Step 6: Commit** `refactor: browser-safe OAuth helpers in @topics/client, shared with CLI`.

---

### Task 3: Display and access helpers

**Files:**
- Create: `client/src/access.ts`, `client/src/access.test.ts`, `web/src/format.ts`, `web/src/format.test.ts`
- Modify: `client/src/index.ts` (re-export `topicAccess`, `parseLifetime`), `cli/src/args.ts` (re-export `parseLifetime` from `@topics/client` instead of defining it)

**Interfaces:**
- Produces:
  - `topicAccess(claims: { sub: string; saids: string[] }, topic: Pick<TopicInfo, 'owner' | 'readPolicies' | 'writePolicies'>): { read: boolean; write: boolean }`. The owner always passes. Otherwise it is any-of over the policy list, and an empty list means owner-only. This mirrors the module rule.
  - `parseLifetime(s: string): number` moves to `client/src/access.ts` unchanged, so the web app can use it. The existing `cli/src/args.test.ts` cases still cover it through the CLI re-export.
  - `web/src/format.ts`:
    - `parseSaids(input: string): string[]`. Split on commas, trim, drop empties, keep order, de-duplicate.
    - `displayPayload(b: Uint8Array): string`. Returns UTF-8 text when valid, after replacing C0/C1/DEL with `\xNN` (same rule as CLI `displayText`), otherwise `hex:` plus lowercase hex.

- [ ] **Step 1: Write the tests:**

```ts
// client/src/access.test.ts
test('topicAccess', () => {
  const t = { owner: 'bob', readPolicies: ['R'], writePolicies: ['W', 'X'] };
  expect(topicAccess({ sub: 'a', saids: ['R'] }, t)).toEqual({ read: true, write: false });
  expect(topicAccess({ sub: 'a', saids: ['X'] }, t)).toEqual({ read: false, write: true });
  expect(topicAccess({ sub: 'bob', saids: [] }, t)).toEqual({ read: true, write: true });
  expect(topicAccess({ sub: 'a', saids: ['R'] }, { owner: 'bob', readPolicies: [], writePolicies: [] }))
    .toEqual({ read: false, write: false });
});
// web/src/format.test.ts
test('parseSaids', () => expect(parseSaids(' A, ,B ,A,')).toEqual(['A', 'B']));
test('displayPayload', () => {
  expect(displayPayload(new TextEncoder().encode('héllo'))).toBe('héllo');
  expect(displayPayload(new TextEncoder().encode('a\nb'))).toBe('a\\x0ab');
  expect(displayPayload(new Uint8Array([0xff, 0x00, 0x10]))).toBe('hex:ff0010');
});
```

- [ ] **Step 2: Run** `bun test ./client/src/access.test.ts ./web/src/format.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** `bun test ./client/src/access.test.ts ./web/src/format.test.ts ./cli/src/args.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: topicAccess and web display helpers`.

---

### Task 4: The web app

**Files:**
- Create:
  - `web/package.json`: name `@topics/web`, private, `"type": "module"`, scripts `dev: vite`, `build: tsc --noEmit && vite build`; deps `@topics/client: workspace:*`, react and react-dom; devDeps vite, @vitejs/plugin-react, typescript `~5.6.2`, @types/react and @types/react-dom, at the versions in Global Constraints.
  - `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`
  - `web/src/{main,App,ConnectionPane,TopicsPane,TopicPane}.tsx`, `web/src/session.ts`, `web/src/styles.css`
- Modify: root `package.json` (add workspace `web`; add `./web` to the `test` script paths), `Makefile`, `README.md`

**Interfaces:**
- Consumes: Task 1 `watch(..., onError)` and `pull` rejection; Task 2 `createPkce, discover, authorizeUrl, parseCallback, exchangeCode, refreshTokens, pickToken, decodeClaims`; Task 3 `topicAccess, parseSaids, displayPayload`; the existing `connect`, `Client`, `TopicInfo`, `Envelope` and `decodeExp`.
- `vite.config.ts`:
  - React plugin
  - `server: { host: '127.0.0.1', port: 5173, strictPort: true }`
  - `resolve.alias: { '@topics/client': <abs path to client/src/index.ts> }`, so no client build is needed
  - The dev server serves `index.html` for `/callback` by default (SPA fallback).
- `session.ts`:
  - `type Settings = { walletUrl: string; server: string; db: string }`
  - `loadSettings(): Settings`, `saveSettings(s)`, `loadTokens(): Tokens | null`, `saveTokens(t | null)`
  - `beginLogin(s: Settings): Promise<void>`. Discovers the endpoints, creates the PKCE values, stores `{ verifier, state, walletUrl }` in sessionStorage, and redirects.
  - `completeLogin(url: string): Promise<Tokens>`. Runs `parseCallback`, then `exchangeCode` using the stored `walletUrl`, deletes the pending state, saves the tokens, and does `history.replaceState` to `/`.
  - `refresh(s): Promise<Tokens | undefined>`
  - `CLIENT_ID = window.location.origin`. Before redirecting, `beginLogin` throws `open the UI at http://127.0.0.1:5173 (kerits needs a stable origin)` if `CLIENT_ID !== 'http://127.0.0.1:5173'`.
- `App.tsx` state:
  - `settings`, `tokens`, `client: Client | null`, `claims`, `group`, `topics: TopicInfo[]`, `selected?: TopicInfo`
  - On mount: if the path is `/callback`, run `completeLogin`. Then, if there are tokens, `connect({ uri, db, token, onExpired: () => refresh(...).then(t => t?.token) })`.
  - When `client.closed` resolves to `'expired'`, clear the tokens and show "signed out — token expired".
- The panes render exactly the fields in the spec's Layout section. Each action button has its own inline error slot that shows `err.message` verbatim, plus a busy state.
  - TopicsPane rows show `name · read: … · write: … · expires …`, plus badges `can read` / `can write` from `topicAccess(claims, topic)`.
  - TopicPane message rows show `sentAt.toLocaleTimeString()`, `sender`, `displayPayload(payload)`, `digest.slice(0,12)…`, and `<n> bytes`.
  - Stream toggle on → `client.watch(addr, append, setStreamError)`. Off → call the returned function. Switching topics turns it off.
  - Pull replaces the list. Send clears the input on success.
- `Makefile`: `web:` → `bun run --cwd web dev`. Add it to `.PHONY`.
- README "Web UI" section:
  - `make dev`, publish, then `set_config` with `trustedIssuer = <wallet URL>` and `allowedAudiences` including `http://127.0.0.1:5173`
  - `make web`, then open `http://127.0.0.1:5173`
  - Tokens are kept in localStorage (dev tool).
  - Wallet servers other than kerits must allow CORS from that origin.

- [ ] **Step 1: Scaffold** the files above, `bun install`, and confirm `bun run --cwd web build` succeeds on a minimal `<App/>`. Expected: `vite build` writes `web/dist/index.html`.
- [ ] **Step 2: Implement `session.ts`** and the Connection pane: settings inputs, Authenticate, token panel with a live expiry countdown, sign out.
- [ ] **Step 3: Implement the Topics pane:** group input, Create group, Load topics, topic list with badges, Create topic form (lifetime via `parseLifetime` from `@topics/client`; empty = no lifetime).
- [ ] **Step 4: Implement the Topic pane:** messages list, Pull, Stream toggle, send box.
- [ ] **Step 5: Run** `bun run --cwd web build && bun run test`. Expected: tsc clean, vite build OK, all unit tests PASS.
- [ ] **Step 6: Manual check.** It needs a wallet, so the user does it.
  1. `make dev`, publish, and `set_config` for kerits + `http://127.0.0.1:5173`.
  2. `make web`, then Authenticate. The token panel shows your sub and SAIDs.
  3. Create a group, create a topic with your SAIDs, Load topics, and check the badges.
  4. Send, Pull, then Stream from a second tab.
  5. Send without the write SAID and expect the verbatim "send requires one of [...]".
  6. Record the outcome in the README "Still to verify" section.
- [ ] **Step 7: Commit** `feat: web reference UI`.
