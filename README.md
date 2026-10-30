# topics

Policy-gated groups and topics on [SpacetimeDB](https://spacetimedb.com). Access is decided entirely by
kerits policy SAIDs carried in JWTs from `https://oauth.kerits.id` (configurable). Messages are opaque
bytes in an envelope: `{ id, group, topic, sentAt, sender, digest, payload }`. The server sets
`sentAt`, `sender` (JWT `sub`) and `digest` (SHA-256 hex of the payload).

| Path | What |
|---|---|
| `module/` | SpacetimeDB module (TypeScript) |
| `client/` | `@topics/client`, browser + Bun library |
| `cli/` | `chat` CLI |
| `web/` | reference web UI (Vite + React), local only |
| `dev-issuer/` | local ES256 issuer for tests and dev (never for production) |
| `e2e/` | end-to-end tests against a local SpacetimeDB |

## Permissions

- **create group**: the token must carry `config.createGroupPolicy` (e.g. your `onboarded` SAID). Until `set_config` sets it, nobody can create groups.
- **create topic in a group**: the token must carry one of the group's `createTopicPolicies`.
- **read / write a topic**: the token must carry one of the topic's `readPolicies` / `writePolicies`.
- Owners (same `sub`) always pass on their own group or topic. Lists are any-of. An empty list means owner only.
- Group/topic names: `^[a-z0-9][a-z0-9_-]{0,63}$`; topics are addressed `group.topic`. Max payload is 64 KiB.

## Run locally

```sh
bun install
spacetime start --listen-addr 127.0.0.1:3010        # the CLI's `local` server entry
spacetime publish -s local relay --module-path module -y

bun dev-issuer/src/main.ts                          # prints http://127.0.0.1:7864 and a /mint URL
spacetime call -s local relay set_config http://127.0.0.1:7864 ONBOARDED kerits.policySAIDs '["topics-dev"]'

export TOPICS_SERVER=ws://127.0.0.1:3010 TOPICS_DB=relay
export TOPICS_TOKEN=$(curl -s 'http://127.0.0.1:7864/mint?sub=alice&saids=ONBOARDED,ABC1235,XYZ,HKI&ttl=3600')
alias chat='bun cli/src/main.ts'

chat group create --name example --permissions '{"create-topic-policy":"ABC1235"}'
chat topic create --name foo --group example --permissions '{"read-policy":"XYZ","write-policy":"HKI"}' --lifetime 7d
chat topic list --group example
chat send --topic example.foo -m "hello world"
chat pull --topic example.foo
chat pull --topic example.foo --watch
```

The dev issuer generates a new key every time it starts, but SpacetimeDB caches JWKS per issuer URL. After
restarting the issuer, either use a new `PORT=` or restart SpacetimeDB.

`set_config` can only be called by the identity that published the module. Its last argument is the list of
accepted token audiences. kerits sets `aud` to the client origin, e.g. `http://127.0.0.1:7863` for the CLI.
**Set it in production.** An empty list accepts any audience, which means a token kerits issued to any other
app would work here too.

## Web UI

A three-pane reference UI for developers: connection and token on the left, groups and topics in the middle,
and the selected topic's messages, send box and live stream on the right. Every parameter is editable, and
server errors are shown word for word.

```sh
make dev                                              # SpacetimeDB on 127.0.0.1:3010
spacetime publish -s local relay --module-path module -y
spacetime call -s local relay set_config https://oauth.kerits.id <onboarded SAID> kerits.policySAIDs \
  '["http://127.0.0.1:5173"]'
make ui                                               # then open http://127.0.0.1:5173 (not localhost)
```

- **Authenticate with kerits** runs PKCE in the browser. The client id is the page origin,
  `http://127.0.0.1:5173`, and the redirect is `/callback` on that origin. Add that origin to
  `allowedAudiences`, and set `trustedIssuer` to the wallet server URL you use.
- Wallet servers other than kerits must allow CORS from `http://127.0.0.1:5173` on discovery and `/token`.
  kerits already does.
- The settings and tokens (including the refresh token) are kept in `localStorage`. That's fine for a local
  dev tool, but don't host it like this.
- SpacetimeDB URL and database changes apply when you click **Reconnect**.
- The "can read / can write" badges compare your token's SAIDs with each topic's policies (owner always
  passes). An empty Pull on a readable-looking topic just means no messages.

## Auth off (dev)

To try groups and topics without any tokens or SAIDs, switch auth off for one database:

```sh
make auth-off                  # = spacetime call -s local relay set_auth_disabled true (admin only)
TOPICS_NO_AUTH=1 chat group create --name test --server ws://127.0.0.1:3010 --db relay   # or --no-auth
make auth-on                   # back on; drops every session, so clients reconnect with a token
```

While it's off:
- Any connection is accepted, with or without a token, and the issuer, audience and expiry aren't checked.
- Your identity is the token's `sub` if you sent one, otherwise your SpacetimeDB identity (hex).
- Every create and send passes, and everyone can read every topic.
- Policies are still stored and listed, so you can set them (empty or not) and see them.

Auth is on unless you switch it off. The web UI's **Connect without auth** button connects with no token.
When auth is off, the web UI shows a red **AUTH DISABLED** banner and `make dev-status` says so too.
Don't leave it off on maincloud.

## Tests

```sh
bun run test        # unit tests (+ client build and a browser-safety check)
bun run test:e2e    # needs `spacetime start --listen-addr 127.0.0.1:3010`; ~1 min (expiry tests wait for the sweep)
```

## Deploy to maincloud

```sh
make deploy                       # = spacetime publish -s maincloud relay --module-path module -y
spacetime call -s maincloud relay set_config https://oauth.kerits.id <onboarded SAID> kerits.policySAIDs \
  '["http://127.0.0.1:7863", "https://<your web app origin>"]'
```

`set_config` is only needed after the first deploy. Later deploys keep the data and config. A schema change
that would delete data is refused instead of applied. To deploy somewhere else, use
`make deploy DEPLOY_SERVER=… DEPLOY_DB=…`.

### CI

`.github/workflows/ci.yml` runs on every push and pull request. It runs the unit tests and builds the web UI, then
starts a local SpacetimeDB and runs the e2e tests. If everything passes on a push to `master`, it runs
`make deploy` against maincloud.

Before the first CI deploy, set up the GitHub repo:
- **Secret `SPACETIME_TOKEN`:** the token from `spacetime login show --token`. Use the identity that first
  published the database, because it owns the database and is its admin.
- **Variable `SPACETIME_DB`** (optional): the database name. The default is `relay`.

Then `chat auth` (defaults: `--server wss://maincloud.spacetimedb.com --db relay --issuer https://oauth.kerits.id`).

## CLI auth

`chat auth` runs auth-code + PKCE (S256) against the issuer and receives the code on a **fixed** loopback port
(default `7863`; `--port` / `TOPICS_AUTH_PORT`). kerits treats `http://127.0.0.1:<port>` as the client id,
so a different port is a different client and old refresh tokens stop working. Tokens are stored in
`~/.config/topics-chat/config.json` (mode 0600). A token with less than 30s left counts as expired. Expired tokens are refreshed automatically when a
refresh token exists; `pull --watch` reconnects on refresh. `TOPICS_TOKEN` overrides the stored token
and is never refreshed.

The CLI uses whichever of `id_token` / `access_token` carries `kerits.policySAIDs` (flat key or nested
`kerits.policySAIDs`). Otherwise it uses `id_token`.

## Library

```ts
import { connect } from '@topics/client';

const client = await connect({
  uri: 'wss://maincloud.spacetimedb.com',
  db: 'relay',
  token,                                     // kerits JWT
  onExpired: async () => getFreshToken(),    // optional; return undefined to stop
});
await client.createGroup('example', { createTopicPolicies: ['ABC1235'] });
await client.createTopic('example.foo', { readPolicies: ['XYZ'], writePolicies: ['HKI'], lifetimeSecs: 86400 });
await client.send('example.foo', new TextEncoder().encode('hello'));
const msgs = await client.pull('example.foo', { afterId: 10n, limit: 50 });
const stop = client.watch('example.foo', env => console.log(env.sender, env.payload));
console.log(await client.closed);            // 'expired' | 'closed'
```

The library sends the JWT directly, not through the SDK's token exchange, because that exchange rewrites
`exp` and the module needs the real expiry. In Bun and Node (22 or later, which have a global WebSocket)
it goes in an `Authorization` header. Browsers can't set websocket headers, so there it goes in `?token=`
on the URL, where proxies may log it.

## Known issues

1. **Expired-token streams are cut server-side by a sweep, not instantly.** SpacetimeDB doesn't re-check
   `exp` on open connections and a module can't force-disconnect. A sweep runs every 15s and drops expired
   sessions, after which the reader receives nothing new. The client library also closes its own
   connection at `exp`. A misbehaving client can keep the socket open, but it receives nothing new.
2. **One session per identity.** If a subject connects twice with different tokens, the most recent
   token's policies and expiry apply to reads.
3. **Policy freshness = token freshness.** If a wallet stops vouching for a policy, access continues
   until the token expires.
4. SpacetimeDB accepts tokens up to ~60s past `exp` at connect time. The module then rejects them,
   because it checks `exp` itself.
5. Reads go through one `my_messages` view that recomputes on change (SpacetimeDB 2.12 TypeScript views
   take no parameters), and `pull` paging happens on the client. Fine for chat-sized topics.

## Still to verify against real kerits

Run `chat auth` once with a real wallet against a database configured for `https://oauth.kerits.id`.
Decode the stored token and confirm the policy claim's exact key, and whether it's on the ID token or the
access token.
