# Web reference UI — design

## Intent

A local web app for **the author and other developers to check that the system works** end to end
with a real kerits login. It also shows how to use `@topics/client` in a browser. It is not an end-user
chat product: exposing parameters, state and raw errors matters more than polish.

Builds on the existing system (`docs/superpowers/specs/2026-10-29-topics-design.md`), which is already
implemented: module, `@topics/client`, `chat` CLI.

## Goals

- **Real kerits login in the browser.** An "Authenticate with kerits" button runs auth-code + PKCE (S256)
  against a **user-supplied wallet server URL** (default `https://oauth.kerits.id`).
- Every parameter is exposed: wallet URL, SpacetimeDB URL, database name, group name, topic name,
  create-topic policy SAIDs, read policy SAIDs, write policy SAIDs, and lifetime.
- Operations: create group, create topic, list a group's topics, send, pull, and stream (watch) a topic.
- Show the decoded token (`sub`, policy SAIDs, live expiry countdown). Mark each topic with whether the
  current token can read it and/or write it.
- Show server errors inline, verbatim, next to the action that caused them.

## Non-goals

- Hosting or deploying it anywhere. It is **local only** for now.
- A list of all groups. The library has no such call, so the user types a group name.
- Visual polish, a UI component library, or mobile layout.
- A dev-issuer or paste-a-token sign-in path. The user asked for real kerits login.

## Anti-goals

- Business logic in the UI that the library should own. The UI calls `@topics/client` only, plus a small
  browser auth helper.
- Hiding failures. An error must never be swallowed or replaced with a generic message.

## Layout (chosen: three-pane explorer)

**Left: Connection**
- Inputs for wallet server URL, SpacetimeDB URL (default `ws://127.0.0.1:3010`) and database (default `topics`).
- The **Authenticate with kerits** button.
- A token panel: `sub`, policy SAIDs, and the expiry countdown.
- On expiry the UI tries a refresh. If that fails it shows "signed out" and the button again.

**Middle: Groups & topics**
- A group name input with **Create group** (create-topic SAIDs, comma-separated) and **Load topics**.
- The topic list shows name, read SAIDs, write SAIDs, expiry, and "can read / can write" badges.
- **Create topic** takes a name, read SAIDs, write SAIDs, and a lifetime (`30s|15m|12h|7d`, optional).
- Clicking a topic selects it.

**Right: Selected topic (`group.topic`)**
- Messages show time, sender, the payload as UTF-8 text (hex if not valid UTF-8), digest, and size.
- A **Stream** toggle (`watch`), a **Pull** button, and a send box.

## Decided constraints

- Lives at `web/` as a new Bun workspace. Vite + React + TypeScript, plain CSS, depends on `@topics/client`.
- Runs at the fixed origin `http://127.0.0.1:5173`, never `localhost`, so the kerits client id
  (= origin) stays stable.
  - `client_id = http://127.0.0.1:5173`
  - `redirect_uri = http://127.0.0.1:5173/callback`
- To use it against a database, add `http://127.0.0.1:5173` to that database's `allowedAudiences` and
  set its `trustedIssuer` to the wallet server URL. The README documents this.
- Settings and the refresh token persist in `localStorage`, so a page reload doesn't sign you out.
  This is acceptable for a local dev tool, and the README notes it.
- There is a `make ui` target to run it.
- Tests are minimal:
  - a unit test for the browser auth helper (PKCE challenge, authorize URL, callback parsing / state check)
  - a unit test for the "can read / can write" check
  - `vite build` must succeed

## Library changes (my call)

The UI must never swallow errors, and today two library calls can fail silently, so the plan makes
small changes to `@topics/client`, each with a test:
- `watch(addr, onMessage, onError?)`: `onError` fires on an unknown topic or a failed subscription.
  Today the watch just stops.
- `pull()` on an unknown topic rejects with `no such topic <addr>` instead of returning `[]`.
- An empty result from a topic that exists stays `[]`, whether there are no messages or the token can't
  read them. The server deliberately doesn't say which, so the UI's "can read" badge explains the
  difference.

## Risks / to verify

- **CORS: verified 2026-10-29.** kerits answers `Origin: http://127.0.0.1:5173` with
  `access-control-allow-origin: http://127.0.0.1:5173` on both discovery (GET) and `/token`
  (POST preflight, `content-type` allowed). The browser calls kerits directly, with no proxy.
  Wallet servers other than kerits must allow CORS too, and the README says so.
- Whether the refresh grant returns a new `id_token` in the browser flow. This is the same open question
  as for the CLI.

## Left to the builder

- Component breakdown, state management (plain React state/hooks), and styling details.
- Whether the browser auth helper shares code with `cli/src/auth.ts`. Shared pure parts are fine if no
  Node/Bun APIs leak into `web/`.
- Exact reconnect/refresh UX wording.
