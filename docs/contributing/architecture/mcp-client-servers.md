# MCP client servers (user-added MCP servers)

Kody can act as an **MCP client** to remote MCP servers a user adds. Tools
discovered on those servers become synthesized capability domains callable from
execute via `kody.mcp["<server-name>"].<tool>(input)`. This is the inverse of
the `/mcp` endpoint (where Kody is the server) and complements MCP servers
(which dial in to Kody over WebSockets): MCP client servers are **remote-only**
— Kody dials out over HTTP using the Agents SDK `MCPClientManager`.

## Components

- **`McpClientHub` Durable Object** (`packages/worker/src/mcp-client/hub.ts`) —
  class owned by `kody-platform`; origin and runtime bind `MCP_CLIENT_HUB` with
  `script_name`. One per user, id derived from the stable MCP `userId`. Owns the
  Agents SDK `MCPClientManager`, which persists registered servers, OAuth client
  registrations, and tokens in the DO's SQLite storage. Exposes RPC methods:
  `addServer`, `reconnectServer`, `refreshServer`, `removeServer`,
  `setPreRegisteredOAuthClient`, `readPendingAuthorization`,
  `handleOAuthCallback`, `getSnapshot`, `callTool`, and
  `purgeForAccountDeletion`.
- **D1 `mcp_server_settings` table**
  (`packages/worker/migrations/0001-squashed-init.sql`, usage columns in
  `0031-mcp-server-package-usage.sql`, `last_error` in
  `0054-mcp-server-last-error.sql`) — user-scoped metadata (id, name, url,
  enabled, `usage_mode` / `allowed_packages_json`, optional favicon columns, and
  a sanitized `last_error` JSON blob for incomplete post-IdP settle). D1 answers
  "which servers does this user have enabled" without waking the DO; the DO owns
  live connection state and tokens. Live `connectionError` on the hub is
  ephemeral, so an IdP-success / not-ready settle writes `last_error` and the
  account UI shows it under Status. `usage_mode` is `any` (execute plus every
  package) or `packages` (only the listed saved package ids; execute is denied).
  Account-page loads fetch the registrable-domain favicon of `url` with the same
  HTTPS pipeline as user-lane OAuth apps and store a raster under
  `user-mcp-server-logos/{userId}/{id}/`. The signed-in owner loads it from
  `/account/mcp-servers/logos/:serverId`. Display order matches OAuth
  integrations: operator-curated provider mark (matched by server name or `url`
  host), then auto-favicon, then the letter fallback.
- **Hub client with snapshot cache**
  (`packages/worker/src/mcp-client/hub-client.ts`) — worker-side facade over the
  DO stub. Snapshots are cached per user for 30 seconds and invalidated on every
  mutation.
- **Settings service** (`packages/worker/src/mcp-client/settings-service.ts`) —
  validates names (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`) and URLs (https
  required; plain http allowed only for loopback hosts), and keeps D1 and the
  hub DO in sync. Optional `bearerToken` values are normalized into an
  `Authorization` header and stored only in the hub DO's Agents SDK
  `server_options` (never in D1 or list/detail API responses). At
  `registerServer`, the hub copies those static `transport.headers` into
  `transport.requestInit.headers` so outbound fetches send them
  (`packages/worker/src/mcp-client/transport-headers.ts`); explicit
  `requestInit.headers` still win. Outbound connections prefer MCP `2026-07-28`
  (`server/discover`) and fall back to the 2025 `initialize` handshake when the
  remote server is actually 2025-era **or** when modern negotiation reaches
  `connected` / `discovering` but catalog never becomes `ready` (same-server
  retry with `versionNegotiation: { mode: 'legacy' }`, no hostname allowlist).
  Restore and reconnect drop persisted 2025 `sessionId` / `protocolVersion` /
  `discoverResult` values and rewrite stored `client.versionNegotiation` to
  `{ mode: 'auto' }` so a stored 2025 session or an accidental persisted
  `legacy` mode cannot skip the modern probe or DELETE a session against a
  modern-only server (`packages/worker/src/mcp-client/restore.ts`,
  `packages/worker/src/mcp-client/reconnect.ts`). A successful catalog-timeout
  fallback is remembered per server in hub DO storage when that retry reaches
  `ready` or parks on OAuth `authenticating`, so the next restore keeps
  `legacy`; user reconnect or replacing the server via `addServer` forgets that
  mark and probes `auto` again. Header-mismatch, unauthenticated, and `-32022`
  UnsupportedProtocolVersion probe outcomes are not a 2025 verdict; after OAuth
  the hub retries `server/discover` with the token, then the same
  catalog-timeout legacy retry if discovery still does not finish.

## OAuth flow

1. `addServer` registers the server with a callback URL of
   `<canonical-app-origin>/account/mcp-servers/oauth/callback` (from
   `APP_BASE_URL`, not the request host) and starts connecting. Optional static
   Authorization headers from `bearerToken` are registered on the transport at
   the same time, including the `requestInit` copy so the header is not dropped
   on the wire.
2. If the server requires OAuth, the MCP SDK uses Client ID Metadata Documents
   when the authorization server advertises
   `client_id_metadata_document_supported` and the callback origin is HTTPS:
   Kody presents `{canonical-app-origin}/oauth/client-metadata.json` as
   `client_id`. Otherwise it falls back to Dynamic Client Registration. A server
   whose authorization server offers neither (GitHub's remote MCP is the main
   case) can use a pre-registered OAuth client instead (see
   [Pre-registered OAuth clients](#pre-registered-oauth-clients)). Without one,
   the connect fails and Status says to add one. The connection parks in state
   `authenticating`, and the hub keeps the provider authorization URL in its SQL
   row.
3. The provider URL never leaves the hub client
   (`packages/worker/src/mcp-client/hub-client.ts`): callers get
   `authorizationPending`. Every `authUrl` that the account UI and the
   `mcpServerAdd` / `mcpServerList` / `mcpServerReconnect` capabilities return
   is the Kody consent page `/@<slug>/-/mcp-servers/:serverId/authorize`
   (`packages/worker/src/app/handlers/org-mcp-server-authorize.ts`). That page
   requires a signed-in member of the org in the URL with `integration:write` on
   it. It reads the pending authorization through the hub's
   `readPendingAuthorization` RPC and shows the server name, the authorization
   server host, and the client mode (`pre-registered` when the URL's `client_id`
   is the server's configured client, otherwise `cimd` or `dcr` from that
   `client_id`). Nothing redirects to the provider until the person clicks
   Continue. Continue posts a form token: an HMAC over the person, org, server,
   and pending provider URL
   (`packages/worker/src/mcp-client/authorize-consent.ts`), so a reconnect
   retires older forms. App-wide cross-origin protection rejects cross-site
   posts, and the global CSP forbids framing. The CSP also keeps `form-action`
   on `'self'`, so the browser cannot follow a form redirect to the provider.
   The page posts with fetch, a valid token returns the provider URL as JSON,
   and the page navigates through a `rel="noreferrer"` link so providers that
   check authorized origins on Referer do not see Kody's.
4. The provider redirects back to the callback route. The worker authenticates
   the browser session cookie and picks the hub from the `state` parameter
   (`<nonce>.<serverId>`): the hub of the org that owns that server, when the
   person can bind to that org and has `integration:write` there (the consent
   page's check). Otherwise it uses the session's org, as the callback URL has
   no slug. It forwards the full callback URL to that hub DO, and the SDK
   exchanges the code (matching `state` to the pending authorization) and
   establishes the connection. The redirect after the callback goes to that
   org's MCP servers page.
5. The hub only treats the callback as successful when the connection reaches
   `ready`. After the SDK accepts the authorization code, the hub establishes
   the connection and, if the transport is `connected`, runs
   `discoverIfConnected` the same way add/reconnect do. If that settle does not
   reach `ready`, the callback fails with a sanitized reason that includes the
   observable phase (`token exchange`, `resource metadata`, `mcp initialize`,
   `server/discover`, or `tools/list`), HTTP status and a short body snippet
   when present, the MCP / resource / authorization-server URLs without query
   secrets, and an attempt id for log grep (`mcp discover timeout incomplete`,
   `mcp discover retrying legacy handshake`,
   `mcp oauth callback settle incomplete`). Connection episodes do not store
   that id. The same payload is stored on `mcp_server_settings.last_error` and
   shown under Status. The account UI maps `connected` / `discovering` to
   "Discovering tools" only while that work is still in flight; when
   `last_error` is present it says "Tool discovery didn't finish" instead of
   echoing the raw `"connected"` state. After `discoverIfConnected` times out
   still on `connected` or `discovering` (add, reconnect, refresh, or OAuth
   settle), the hub first retries the 2025 initialize handshake on that same
   server. If catalog still does not finish, it writes the same durable
   `last_error` (`tools/list` after a catalog attempt, otherwise
   `server/discover`, plus attempt id and MCP URL) so Status cannot stay silent.
   Used or missing OAuth `state` on the callback recover without surfacing an
   internal state error. When stored access or refresh tokens are present
   (typical after a prefetch or Back/replay of a callback that already exchanged
   the code), the hub settles with those tokens and does not remint or wipe the
   grant. HEAD probes on the callback path return 200 and do not consume
   `state`. A Back/replay while the connection is still `connected`,
   `discovering`, or `connecting` keeps the existing tokens and retries
   discovery when the transport is `connected`, but it does not report
   `auth=success` or clear `last_error` until the connection is `ready`. A
   successful code exchange clears a stale token-recovery `last_error` so Status
   cannot keep showing "no refresh token" after Authorize. Origin and
   redirect-URI rejection messages are enriched with Kody's `oauthClientOrigin`
   and `oauthCallbackUrl`. When a previously ready connection parks on
   `authenticating`, the hub inspects stored tokens, stamps a durable
   `last_error` (phase `token exchange`) instead of leaving Status silent, and
   `mcpServerList` exposes `hasRefreshToken` without returning token values.
   `saveTokens` keeps an existing refresh token when the authorization server
   omits one (RFC 6749), writes that refresh token to a server-scoped sidecar so
   restore can find it when SQL `client_id` is missing (Agents SDK `tokens()` is
   keyed by client id), serializes overlapping saves, and keeps OAuth discovery
   so the next authorize URL can still list scopes. `tokens()` rebuilds the blob
   from the sidecar and any `/token` keys under that server when the live
   provider has no client id. `invalidateCredentials('tokens'|'client'|'all')`
   infers `clientId` when restore left it unset, deletes leftover `/token` keys
   and the sidecar so a rejected refresh grant cannot be replayed, and skips a
   `tokens` wipe when a save completed after the invalidate was requested; user
   remove and callback-URL remint also delete the sidecar. Discovery refresh
   advertising is read from top-level metadata and from nested
   `authorizationServerMetadata` / `resourceMetadata`. A later grant that
   includes a refresh token clears the ready missing-grant warning from Status.
   Phase `token exchange` on token-recovery `last_error` covers both
   authorization-code exchange and refresh-token grant failure. A grant that
   becomes `ready` without a refresh token, after the authorization server
   advertised `refresh_token` or `offline_access`, keeps a durable Status
   warning instead of looking healthy until the access token expires. Reconnect
   tries `connectToServer` with the stored tokens first so the MCP SDK can
   refresh; it only remints authorization state when that cannot restore `ready`
   and no authorization URL is available, or when the callback URL changed.
   Token blobs stay in place unless the callback URL changed.
   Authorization-server reuse of a rotating refresh token still requires a human
   re-auth. The account page offers Reconnect when automatic recovery cannot
   finish.
6. The route redirects to `/@<slug>/-/mcp-servers/:serverId?auth=success|error`
   when the callback resolves to a server (including failures), or
   `/@<slug>/-/mcp-servers?auth=error` when it does not, for user feedback.
   Tokens live only in the DO storage; they never reach D1 or the client.

Because the callback is resolved through the session cookie, the OAuth state is
looked up in the hub of the org that owns the server when the signed-in person
can bind to that org and has `integration:write` there, and in the session org's
hub otherwise. The callback succeeds only when that hub holds a pending
authorization matching `state`. A person outside the org finds no matching
state; people with `integration:write` in the same org share its hub.

Providers that allowlist client origins or redirect URIs must permit the
canonical app origin and the callback path above. CIMD-capable servers also
fetch `{canonical-app-origin}/oauth/client-metadata.json`; that document's
`client_id` matches its URL and lists the same redirect URI. See
[Connect remote MCP servers](../../use/mcp-client-servers.md).

### Pre-registered OAuth clients

The owner can give one server an OAuth client ID and secret that they registered
with its authorization server. It is set, replaced, and removed only from that
server's settings page (`setMcpServerOAuthClient` /
`removeMcpServerOAuthClient`, which require `integration:write`). No capability,
API response, MCP tool, or page returns the secret after save.

- **Storage.** The worker seals the secret with `SECRET_STORE_KEY` (purpose
  `mcp-server-oauth-client-secret`, AAD bound to the server id) before it calls
  the hub. The hub stores only `{ clientId, sealedClientSecret }`, next to the
  tokens the client is used to obtain
  (`packages/worker/src/mcp-client/preregistered-oauth-client.ts`). The hub is
  the only store for the client. Its snapshot carries the public client id so
  the settings page can show the client as configured, with Replace and Remove.
- **Use.** The hub's OAuth provider answers `clientInformation()` with the
  configured client, which the MCP SDK reads before it considers CIMD or DCR. So
  a configured client always wins. The SDK then authenticates the token request
  with `client_secret_basic` or `client_secret_post`, whichever the
  authorization server supports. The SDK's re-save of that client info is
  skipped, so the opened secret never lands in plain DO storage.
- **Changes.** Saving, replacing, or removing a client drops the server's tokens
  and any CIMD or DCR registration, because the authorization server issued them
  to the previous client, and it starts a fresh connection episode so the parked
  approval is not reported as a failed token refresh. It then starts a fresh
  authorization. Once the new client is stored the change is committed; if the
  restart fails, the server reports that as its last error instead of rolling
  back. Changes to one server run one at a time in the hub.
- **Audit.** Each write records an org audit event
  (`mcp_server.oauth_client_set`, `mcp_server.oauth_client_replaced`,
  `mcp_server.oauth_client_removed`) with the server name and client id, never
  the secret.

## Capability synthesis and invocation

- Registry: `getCapabilityRegistryForContext` loads enabled server refs from D1
  that the caller may use (`any`, or `packages` including the current
  `storageContext.packageId`) and hub snapshots, then
  `synthesizeMcpServerToolDomain`
  (`packages/worker/src/mcp/capabilities/mcp-server/index.ts`) creates a
  `mcp:<server-name>` domain with a capability per discovered tool
  (`mcp:<server-name>:<tool>`), marked `source: 'mcp-server'`. Unscoped
  `search({ query })` ranks the **server** (name, description, and remote
  instructions) as an `mcp-server` entity, not every tool. List tools with
  `search({ entity: "mcp-server:<name>" })` or
  `search({ domain: "mcp:<name>" })`.
- Execute: the `kody.mcp` proxy exposes tools as
  `kody.mcp["<server-name>"].<tool>(input)` and never as flat `kody.*`
  functions. Search capability detail returns the exact accessor.
- Tool calls flow worker → credential door `callTool` → hub DO `callTool` →
  `MCPClientManager.callTool` → remote server. The door writes one `mcp.call`
  org audit row per invocation (tool name, server, success or failure, error
  class, duration) and does not record arguments or return values.
  `credential.resolve` stays the single row for the connection decision. At the
  synthesized capability boundary, results are wrapped with explicit
  `__mcpContent` / companion markers when protocol content must reach the
  upstream client (especially non-text blocks such as images). Structured
  content remains available for code; `isError` is preserved. See
  [Raw MCP content blocks](../../use/raw-content-blocks.md).
- Malformed third-party content blocks are rejected with a source-specific
  error. Image/audio URL-only payloads are not fetched.

## Management surfaces

- **UI**: `/@<slug>/-/mcp-servers` (add with optional bearer token, authorize,
  reconnect, refresh tools, enable/disable, set package usage, set a
  pre-registered OAuth client, remove; shows live state, discovered tools, and
  the server mark next to the name — catalog first, then favicon, then a
  letter).
- **Capabilities**: the `mcpServers` domain (`mcpServerAdd`, `mcpServerList`,
  `mcpServerReconnect`, `mcpServerRefresh`, `mcpServerRemove`,
  `mcpServerSetEnabled`, `mcpServerLock`). `mcpServerAdd` accepts optional
  `bearerToken`. `mcpServerLock` grants a package; unlock is website-only.
  Integration connections use the same tighten-only shape (`integrationLock`).
  User-secret package grants are website-only; `secretLock` returns an approval
  URL and does not add `allowed_packages`.

## Isolation and lifecycle

- Every path is scoped by `userId`: D1 rows, the hub DO id, and registry
  synthesis. Account deletion purges the hub DO storage
  (`purgeForAccountDeletion`) and deletes `mcp_server_settings` rows; account
  export includes the settings rows.
- Connection episodes live in hub DO storage (`mcp-connection-episode/<id>`).
  After a server has been `ready`, a later `disconnected` / `failed` state gets
  two lightweight reconnects (`connectToServer` + discover, no OAuth restart)
  before `mcp.server.disconnected` fans out to the owning user's packages.
  Token-recovery parks that stamp `last_error` (including access-token-only “no
  refresh token” parks that never wrote `wasReady`) also queue that disconnected
  episode as working → failed. The hub client peeks pending events after
  snapshots, waiting/search peeks, and hub mutations, dispatches them to
  same-user subscriber packages (using `waitUntil` on account, waiting, and
  callback requests), then acks only the dispatched event ids so a later-queued
  episode stays pending. Incomplete discovery, retryable invoke failures, and a
  failed enabled-server lookup leave the notice pending instead of acking.
  Recovery emits `mcp.server.reconnected`. `mcpServerReconnect` is the explicit
  authorization restart. See
  [Package subscriptions](../../guides/package-subscriptions.md).

## Related docs

- [Data storage](./data-storage.md) — D1 vs Durable Object storage split.
