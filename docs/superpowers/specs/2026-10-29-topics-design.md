# Topics — policy-gated groups & topics on SpacetimeDB

## Intent

A drop-in, "insert streaming here" pub/sub layer. Access is driven entirely by
kerits (KERI) policy SAIDs carried in JWTs issued by `https://oauth.kerits.id`.
The system knows nothing about *why* a subject qualifies — a user's kerits
wallet does that work and produces a JWT saying "this subject currently
satisfies policy X". This system only matches SAIDs.

Example: the operator onboards a user, issues a credential, and the user's
wallet can then vouch for the `onboarded` policy. That user can create groups.
Users create their own credentials/policies ("kids in my local school",
"people near me") and attach those policy SAIDs to their groups and topics.

Deliverables (v1):

1. **SpacetimeDB module** (TypeScript), runnable locally (`spacetime start`) and
   deployable to SpacetimeDB cloud (maincloud).
2. **TypeScript client library**, built with Bun, usable unchanged from Node/Bun
   CLIs and browsers.
3. **`chat` CLI** built on the library.

## Goals

- Three permission layers, all expressed as policy SAIDs:
  - **System**: creating a group requires the configured "create group" policy
    SAID (e.g. the operator's `onboarded` policy).
  - **Group**: the group declares which policy SAID(s) may create topics in it.
  - **Topic**: the topic declares which policy SAID(s) may read and which may
    write, plus settings (lifetime).
- Messages are opaque bytes in an envelope: send time, sender subject, group,
  topic, payload digest. The server never interprets the payload.
- Auth is configurable: trusted issuer and the create-group policy SAID are
  settings, not constants, so local testing can use a dev issuer.
- Streams end when the JWT expires; clients refresh and reconnect.
- Library and CLI support: auth, create group, create topic, **list topics in a
  group** (name, read policy SAIDs, write policy SAIDs, plus lifetime/expiry),
  send, pull, watch. Policy SAIDs are opaque strings.

## Non-goals (v1)

- Rate limits / quotas / fair use. But every action routes through one
  `authorize(ctx, action, target)` function in the module — that is where they
  get inserted later.
- Web app (library must be browser-compatible, but no web UI is built).
- Mobile.
- Payload encryption or interpretation.
- Editing/deleting groups or topics after creation (beyond lifetime expiry).

## Anti-goals

- The server must not leak messages to subjects lacking the topic's read
  policy.
- The library must not be CLI-shaped: no filesystem/process assumptions in the
  core, so the web app can drop it in.
- No policy logic beyond SAID set-membership in this system — policy meaning
  lives in kerits.

## Constraints & findings (researched 2026-10-29)

- Local tooling: SpacetimeDB CLI 2.12.0, Bun 1.3.13.
- **kerits OIDC**: issuer `https://oauth.kerits.id`, JWKS at `/jwks`, ES256,
  auth-code + PKCE (S256 only), public clients (no secret). The policy SAIDs
  arrive in the claim `kerits.policySAIDs` (string array) — per the user; not
  listed in discovery. Builder should confirm the exact claim key from a real
  token (literal key `"kerits.policySAIDs"` vs nested `kerits: { policySAIDs }`)
  and support whichever it is. Also confirm whether it is on the ID token or the
  access token, and connect with that one.
- **How SAIDs get into the token**: this system never requests policies. The
  kerits auth flow matches the user's identities against policies, the user
  presents proof to the OAuth service, and it grants (or withholds) the JWT.
  This system just reads whatever SAIDs the token carries. When an action is
  denied, the error names the policy SAID(s) that would satisfy it, so the
  user knows what to authenticate for.
- **`sub` is stable** across all clients/connections for a user. A different
  `sub` is a different user. Ownership and `sender` key on `sub`.
- **kerits client identity**: `client_id` is the app's origin;
  `redirect_uri` must be same origin, port included. Plain http allowed only
  on loopback (`127.0.0.1`, `localhost`, `[::1]` — these are distinct origins).
  Each port is a different client; refresh tokens only work from the same
  origin. ⇒ **The CLI uses a fixed loopback port** (default chosen by builder,
  overridable by flag/env), `client_id = http://127.0.0.1:<port>`,
  `redirect_uri = http://127.0.0.1:<port>/callback`.
- **SpacetimeDB auth**: validates OIDC tokens; identity is derived from
  `iss`+`sub`. Reducers read claims via `ctx.senderAuth.jwt.fullPayload`.
  `clientConnected` can reject a connection by throwing `SenderError`.
- **SpacetimeDB reads**: views (`ViewContext`) see only `ctx.sender` (identity),
  **not JWT claims**. RLS is experimental; docs recommend views.
- No evidence SpacetimeDB re-checks `exp` on open connections, nor that a
  module can force-disconnect a client.

## Design (decided)

### Data model (module)

- `config` (singleton): `trustedIssuer`, `createGroupPolicy` (SAID),
  `policyClaim` (claim key, default `kerits.policySAIDs`). Set by the module
  owner via an owner-only reducer; initialised in `init`.
- `session` (keyed by identity): `subject`, `policySAIDs: string[]`,
  `expiresAt` (from `exp`). Upserted in `clientConnected`. Removed by a
  scheduled sweep when expired (and on disconnect only if no other connection
  for that identity remains). *(My call)* No `refresh_session` reducer: a
  reducer call carries the connection's original JWT, so refreshing means
  reconnecting with the new token.
- `group`: `name` (unique), `owner` subject, `createTopicPolicies: string[]`,
  `createdAt`.
- `topic`: `group` + `name` (unique together, addressed `group.topic`),
  `owner`, `readPolicies: string[]`, `writePolicies: string[]`, `createdAt`,
  `expiresAt` (optional; from lifetime).
- `message` (private table): `id`, `group`, `topic`, `sentAt`, `sender`
  (subject), `digest`, `payload: bytes`.

### Permission rule

A permission list is satisfied if the caller's policy SAIDs intersect it
(any-of). Empty list = nobody (except: decided by builder whether owner is
always allowed — see "left to builder").

All reducers call `authorize(ctx, action, target)`, which reads claims from the
JWT on the call, checks issuer and `exp`, and checks the relevant policy list.

### Reads (the workaround)

- `message` is private. Clients subscribe to a **view** returning messages for
  topics whose `readPolicies` intersect the caller's `session.policySAIDs`
  where the session exists. (View can take `group`/`topic` parameters, or
  filter client-side — builder's choice.)
- Topic/group metadata tables are public (names and policies are not secret).
- A scheduled reducer runs periodically (≈15s) to delete expired sessions →
  views re-evaluate → expired readers receive nothing new.

### Expiry

- **Token expiry**: client library closes the connection at `exp` and emits an
  "expired" event; the CLI's `--watch` exits with a clear "token expired, run
  `chat auth`" message (or refreshes automatically if a refresh token is
  stored — builder's call). Server-side cut-off is the sweep above.
- **Refresh** = reconnect: the library accepts a new token and transparently
  reconnects/resubscribes; `--watch` does this if a refresh token is stored.
- **Message retention** *(my call)*: messages live until their topic is
  deleted; no per-message retention in v1. `pull` is paged so history size
  doesn't matter to the client.
- **Topic lifetime**: on creation a topic may set a lifetime; a scheduled
  reducer deletes the topic and all its messages when it lapses.

### Envelope

`{ id, group, topic, sentAt, sender, digest, payload }`. `sentAt` and `sender`
are set by the server (from reducer timestamp and JWT `sub`), not trusted from
the client. `digest` is computed by the server over the payload bytes.

### Client library

- Bun-built, ESM, runs in browser and Bun/Node. Wraps the SpacetimeDB TS SDK
  and generated bindings.
- API surface ≈ `connect({ uri, db, token })`, `createGroup`, `createTopic`, `listTopics(group)`,
  `send(topicAddr, bytes)`, `pull(topicAddr)`, `watch(topicAddr, cb)`,
  `onExpired`. Token acquisition is *not* in the core; an auth helper for
  the CLI (PKCE loopback) lives separately.

### CLI (`chat`)

```
chat auth
chat group create --name example --permissions '{"create-topic-policy":"ABC1235"}'
chat topic create --name foo --group example --permissions '{"read-policy":"XYZ","write-policy":"HKI"}' [--lifetime 7d]
chat topic list --group example
chat send --topic example.foo -m "hello world"
chat pull --topic example.foo [--watch]
```

`chat auth` runs PKCE against the configured issuer via the fixed loopback port,
opens the browser, stores tokens in a per-user config file. Policy values
accept a single SAID or an array.

### Local dev & testing

- `spacetime start` locally, `spacetime publish` the module.
- A small Bun **dev issuer** (OIDC discovery + JWKS + a mint endpoint) issues
  ES256 JWTs with arbitrary `sub`, `exp`, and policy SAIDs, so tests and local
  CLI use don't need a wallet. The module's `trustedIssuer` is pointed at it
  locally.
- End-to-end tests (Bun test) against a local SpacetimeDB covering: create-group
  allowed/denied, create-topic allowed/denied, write allowed/denied, read
  visible/invisible, session expiry stops delivery, topic lifetime deletion.
- Deploy: `spacetime publish --server maincloud`, then set config to the kerits
  issuer and the real `onboarded` SAID.

## Known issues (documented, accepted)

1. **Expired-token streams are cut server-side by the sweep, not instantly.**
   SpacetimeDB doesn't appear to re-check `exp` on open connections or let a
   module force-disconnect. Delivery stops within one sweep interval; a
   misbehaving client can hold the socket open but receives nothing new.
2. **One session per identity.** If a subject connects twice with different
   tokens, the most recent token's policies/expiry win for reads.
3. **Policy freshness = token freshness.** If a wallet stops vouching for a
   policy, access continues until the token expires.

## Left to the builder

- Repo layout (suggest Bun workspace: `module/`, `client/`, `cli/`,
  `dev-issuer/`).
- Digest algorithm (suggest SHA-256, hex or CESR-encoded — pick one,
  document it).
- Group/topic name validation rules.
- Whether owners implicitly hold all permissions on their own group/topic.
- Max payload size (pick a sane default, e.g. 64 KiB, enforced in `send`).
- `pull` paging/`--since` semantics.
- CLI default port, config file location, auto-refresh behaviour.
- Whether `aud` is checked (kerits sets `aud` to the client origin, so a CLI
  and a web app would differ — likely skip or allow-list).
- How the dev issuer is reachable by local SpacetimeDB (it must fetch JWKS;
  confirm http loopback issuers are accepted).
