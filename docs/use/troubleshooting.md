# Troubleshooting

## Contact support

For help with the hosted Kody service at `kody.codes`, open
[`/support`](https://kody.codes/support) or email
[`support@kody.codes`](mailto:support@kody.codes). Operators of other Kody
deployments receive support mail at `support@<apex>`, where `<apex>` is the
deployment's `APP_BASE_URL` hostname.

If the site will not load (NextDNS or similar) or signup / verification mail
never arrives, see
[If you can't open kody.codes or get mail from us](../guides/cant-open-or-get-mail.md)
(`/docs/cant-open-or-get-mail`).

## MCP requests fail with `email_verification_required`

Kody requires a verified account email before any MCP access, including OAuth
authorization. Open the verification link sent at signup, or sign in and use
**Resend verification email** on `/pending-verification`, `/account`, or the
authorize page. Resend is limited to 3 requests every 15 minutes for the account
and 5 verification emails every 24 hours for that address. Password resets do
not count toward that cap. A hard bounce stops further verification mail and
password-reset mail to the address; use a different address or contact support.
A password-reset request still shows the same generic success message. Keep an
open `/oauth/authorize` tab so you can continue the same OAuth request after
verifying in another tab, then reconnect or approve again.

## Codex keeps asking for `codex mcp login kody`

Kody access tokens last one hour. A host that stores the refresh token should
call `/oauth/token` and stay signed in. Cursor does this. Some Codex builds send
the expired access token, get a 401, and ask for a full browser login instead.

Concurrent MCP hosts that share one stored Kody OAuth client can refresh at the
same time. Reusing the previous refresh token returns the current family tokens
instead of minting a new one that invalidates siblings. A consumed token's
one-hour replay is the maximum retention, not a guarantee: after the next
rotation that replay no longer matches and is `invalid_grant`. Tokens outside
the current/previous pair and that window also need a new browser login.

Try this first:

1. Update Codex.
2. Run `codex mcp logout kody`, then `codex mcp login kody`.
3. If two Codex processes still prompt together, update Kody — overlapping
   refreshes on one shared client should stay signed in.

If it still happens about every hour or every new Codex launch, that is the host
skipping refresh. Cursor and Claude Code stay logged in. Email
[`support@kody.codes`](mailto:support@kody.codes) with your Codex version and
how often it asks again if you want us to look.

## Authorize says the request is missing its original connection details

The authorize page needs the original OAuth query (`client_id`, `state`, PKCE).
Clicking Approve before that page finishes loading can replace those parameters
with an empty honeypot field, and the server then asks you to start over. Use
the browser Back button when the previous history entry still has `client_id` in
the URL, or start the connection again from your client.

## The host never opens the Kody authorize window

Dynamic OAuth needs the host to open `/oauth/authorize`. If Admin add-connection
succeeds but enabling the MCP tool in chat never opens that window, retry from
another browser or device. That is a host or environment issue, not a failed
Kody registration. In Open WebUI, do not set an OAuth MCP tool as a model
default or pre-enabled tool — enable it in the chat so the host can open the
authorize window. Hosts that require a pre-registered Client ID and Client
Secret can mint one at Account → Connections → Advanced → MCP OAuth clients
(`/account/mcp-oauth-clients`) and use the host’s static OAuth mode. Static mode
runs authorize and token exchange.

## Adding a remote MCP server fails with `Invalid origin uri` or redirect URI errors

That message comes from the **remote** authorization server, not from Kody being
unreachable. Kody identifies as an OAuth client from the deployment origin and
redirects to `{origin}/account/mcp-servers/oauth/callback`. Allow those values
in the MCP server's identity provider (authorized origins / redirect URIs). When
the authorization server advertises `client_id_metadata_document_supported` and
the callback origin is HTTPS, Kody also presents
`{origin}/oauth/client-metadata.json` as its CIMD `client_id` — allowlist that
URL only for CIMD-capable providers. Then remove and re-add the server. See
[Connect remote MCP servers](./mcp-client-servers.md). For a home process behind
Cloudflare Tunnel and Access, also see
[Connect a home MCP server](../guides/local-mcp-tunnels.md) and
[home-mcp-starter](https://github.com/kody-bot/home-mcp-starter).

## Search returns no good matches

- **Rephrase the query** using domain vocabulary from the search tool’s domain
  hints (for example “GitHub”, “Cloudflare”, “meta capabilities”).
- Try **`metaListCapabilities`** for the full live registry, including dynamic
  entries from MCP servers.
- **`entity: "capability:id"`** looks up a **known** id. It does **not** turn an
  empty ranked **`query`** into better matches — rephrase or list capabilities
  instead.

## Package checks fail with isolate memory or CPU limits

Bundle validation and publish artifact rebuild run in a short-lived isolate. A
large npm dependency graph can exceed that isolate even when ad hoc `execute`
imported the same library. The failure is the graph, not a missing file. Do not
vendor the library or switch to a dynamic import. Keep the package as a thin
orchestrator and run the heavy work in a process the owner operates. See
[Offload work that does not fit a Worker isolate](../guides/heavy-work-offload.md).

## Saved packages missing

Saved packages require an **authenticated MCP user**. If the client is not
signed in, user-scoped package results are empty.

## Fetch or secret errors

- **Host not approved:** complete the approval flow in the app for that secret
  and host. Self-authored and adopted packages still need this host grant.
- **Package not approved for secret:** self-authored and adopted packages can
  read and use user secrets; unadopted community forks need an
  `allowed_packages` grant (or adoption after review). See
  [Secrets and host approval](./secrets-and-values.md#package-approval).

## MCP servers

If tools from a connected MCP server appear missing, open
[`/@<slug>/-/mcp-servers`](./mcp-client-servers.md) (or ask `mcpServerList`) and
confirm the server is connected and authorized. If authorization finished at the
identity provider but Status stays on tool discovery — or add, reconnect, or
refresh times out before tools appear — the Status field shows the last
sanitized settle error (phase, HTTP status, URLs, and an attempt id). Reconnect
from that page. When **Usage** is **Specific packages only**, ad hoc execute and
other packages cannot see or call `kody.mcp["server-name"]` — only granted
packages can. Home automation is a normal outbound MCP server
(`kody.mcp["home"]`). See [Connect remote MCP servers](./mcp-client-servers.md)
and [Lock an MCP server to a package](../guides/locked-mcp-server.md).

After a password reset or an in-account password change, reconnect the MCP host:
Kody revokes OAuth grants and rejects access tokens issued at or before the
change, so a refresh alone is not enough. Signed-in users can also change or set
a password from [Account](https://kody.codes/account) without waiting for a
reset email.

## Job, webhook, or package app failed

Open **[`/@<slug>/-/activity`](./activity.md)** (failures-first) or ask your
agent to use **`runSummary`** / **`runList`** / **`runGet`**. Ad-hoc
**`execute`** runs, including successes, are stored there with jobs, webhooks,
and other surfaces. Switch Activity to **Recent runs** (or pass
`status: success`) to see them; Open errors hides successes.
