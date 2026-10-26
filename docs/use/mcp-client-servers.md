# Connect remote MCP servers to Kody

Kody can act as an **MCP client**: you add a remote MCP server, and its tools
become callable as `kody.mcp["server-name"].tool_name(...)`. That is connection
wiring, not package runtime. See
[Packages, integrations, and MCP servers](../guides/packages-integrations-mcp.md)
when those three look interchangeable.

This is the inverse of [connecting your agent to Kody](./connect-your-agent.md)
(where Kody is the MCP _server_).

## Add a server

1. Open [`/@<slug>/-/mcp-servers`](https://kody.codes/@<slug>/-/mcp-servers), or
   ask your agent to use `mcpServerAdd` with a short kebab-case `name` and the
   server `url` (https required). PostHog's documented endpoint is
   `https://mcp.posthog.com/mcp` — the site root redirects to docs and will not
   finish tool discovery. Kody rewrites that exact origin to `/mcp`.
2. If the server authenticates with a static bearer token (or other))
   Authorization scheme), paste it in the optional Bearer token field — or pass
   `bearerToken` to `mcpServerAdd`. Bare tokens are sent as
   `Authorization: Bearer <token>`; scheme-prefixed values and full
   `Authorization: …` header pastes are normalized. The credential is stored
   only in your private MCP client hub and is never returned later.
3. If the server needs OAuth, Kody returns an authorization link to a Kody page,
   `/@<slug>/-/mcp-servers/:serverId/authorize`. Open it while signed in. It
   shows the server name, the authorization server it will send you to, and how
   Kody identifies itself there (a Client ID Metadata Document, Dynamic Client
   Registration, or a pre-registered OAuth client). Click Continue, sign in at
   the provider, and approve access. Kody never sends you to the provider before
   you click Continue.
4. Confirm with `mcpServerList` (or refresh the account page). The connected
   server shows up in `search` as an **mcp-server** hit (name and server
   instructions). List its tools with `search({ entity: "mcp-server:<name>" })`
   or `search({ domain: "mcp:<name>" })`. If the identity provider approved
   access but tools never appear, Status on `/@<slug>/-/mcp-servers/:serverId`
   shows the last sanitized settle error (phase, HTTP status, URLs, and an
   attempt id). The same durable error is written when add, reconnect, or
   refresh times out still discovering tools after Kody has also retried the
   older MCP handshake. Reconnect from that page.

If a server is authenticating, failed, or disconnected, [Waiting](./waiting.md)
lists it and links to `/@<slug>/-/mcp-servers/:id`. `waitingSummary` returns the
same items. When a server that was already connected later asks for
authorization again, Status and `mcpServerList.error` include the sanitized
token-refresh reason (for example a rejected or already-used refresh token).
`mcpServerList` also reports `hasRefreshToken` so agents can tell whether Kody
still has a refresh token without reading the secret. Kody keeps a stored
refresh token when the server's token response omits a new one, including across
Durable Object restore when the OAuth client id is not in SQL yet. If the
authorization server advertised refresh support but the token response had no
refresh token, Status and `mcpServerList.error` stay visible while the server is
still Connected so the access-token expiry is not a surprise. That warning is
tied to the grant save that omitted the refresh token — not to a later empty
token store after a failed refresh. Concurrent refresh attempts for the same
rotating refresh token share one token-endpoint exchange. Re-authorize clears
stale token blobs for that server so a leftover client-id key cannot shadow the
new grant. One successful Authorize + callback is enough: a replay of the
callback URL settles with the tokens from the first exchange instead of asking
you to approve again. `mcpServerReconnect` tries that refresh before minting a
new authorization link. Packages that subscribe to `mcp.server.disconnected`
(for example a Discord notifier on `package.json#kody.subscriptions`) receive
the event when a previously connected server parks needing re-auth — including
the durable “Authorization required / no refresh token” card — even if waiting
or search notices the park first.

## Lock a server to a package

By default every enabled server is callable from execute and every package. Set
**Usage** on `/@<slug>/-/mcp-servers/:serverId` to **Specific packages only**,
or ask an agent to call
`resourceLock({ kind: 'mcp_server', server, package_id })`.

After that lock:

- Ad hoc execute cannot call `kody.mcp["server-name"]`.
- Packages that are not on the grant list cannot call it either.
- Approved packages still can, including jobs and package apps.
- `mcpServerList` still shows the server to the owner.

Agents can lock (grant). Unlocking or removing a grant is website-only on that
server's account page. See
[Lock an MCP server to a package](../guides/locked-mcp-server.md).

## OAuth allowlists (common failure)

When Kody connects, it identifies itself as an OAuth client using:

- **Client origin:** the deployment's canonical app origin (for hosted Kody,
  `https://kody.codes`)
- **Redirect URI:** `{origin}/account/mcp-servers/oauth/callback`
- **Client ID Metadata Document (HTTPS only):**
  `{origin}/oauth/client-metadata.json`

On HTTPS deployments, Kody presents that CIMD URL as `client_id` when the remote
authorization server advertises `client_id_metadata_document_supported`.
Otherwise it falls back to Dynamic Client Registration. Local `http` origins
skip CIMD and use DCR only.

## Pre-registered OAuth client (GitHub and similar)

Some authorization servers support neither Client ID Metadata Documents nor
Dynamic Client Registration, so Kody cannot register itself. GitHub's remote MCP
server is the common case. Status then says to add a pre-registered OAuth
client.

1. Register an OAuth app with the provider (for GitHub, an OAuth App or GitHub
   App). Set its callback or redirect URI to
   `{origin}/account/mcp-servers/oauth/callback`, as shown on the MCP servers
   page.
2. On `/@<slug>/-/mcp-servers/:serverId`, under **OAuth client**, enter the
   client ID and client secret and click Save. You need permission to manage
   integrations in that organization.
3. Kody starts a fresh authorization with that client. Open the authorization
   link, check that the page says **Pre-registered OAuth client**, and click
   Continue.

The secret is stored sealed and is never shown again. The page shows the client
as configured with its client ID, and offers Replace and Remove. Agents cannot
set or read it: no capability takes or returns the secret. A configured client
is always used, even when the server also supports CIMD or DCR. Saving,
replacing, or removing one signs the server out and asks for authorization
again.

Many authorization servers (including FusionAuth "authorized origins" / redirect
URI settings, and other providers with similar allowlists) reject the authorize
step unless those values are permitted.

If authorization fails with a message like `Invalid origin uri https://…` or an
invalid redirect URI error:

1. In the remote MCP server's identity provider, allow Kody's client origin and
   register the exact redirect URI shown on `/@<slug>/-/mcp-servers` (also
   returned as `oauthClientOrigin` / `oauthCallbackUrl` from `mcpServerAdd` and
   `mcpServerList`).
2. Remove and re-add the server in Kody (or reconnect) so client registration
   picks up the allowlisted values.
3. Authorize again.

Kody itself does not maintain a per-provider allowlist for this flow — the
remote authorization server does.

Servers that do not use OAuth connect immediately and do not need these steps.
Bearer-token servers also skip OAuth when the static Authorization header is
enough for the remote server.

## Home MCP servers

Household LAN tools (notes, lights, TVs, thermostats, local CLIs) belong on a
process you run at home. Publish that process with Cloudflare Tunnel and Access,
then add the HTTPS `/mcp` URL here as `home` (or another short name). The
[home MCP guide](../guides/local-mcp-tunnels.md) and
[home-mcp-starter](https://github.com/kody-bot/home-mcp-starter) cover CIMD
OAuth, Docker, and the Access path split. After authorize, call
`kody.mcp["home"].tool_name(...)`.

## Related

- [Architecture: MCP client servers](../contributing/architecture/mcp-client-servers.md)
- [Troubleshooting](./troubleshooting.md)
