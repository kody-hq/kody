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

OpenAI surfaces (ChatGPT, Codex, and similar) share one OAuth client id. Kody
keeps a separate grant per authorization so reconnecting one surface does not
revoke the others. Concurrent hosts that share one stored refresh family can
also refresh at the same time: reusing the previous refresh token returns the
current family tokens instead of minting a new one that invalidates siblings. A
consumed token's one-hour replay is the maximum retention, not a guarantee:
after the next rotation that replay no longer matches and is `invalid_grant`.
Tokens outside the current/previous pair and that window also need a new browser
login.

Try this first:

1. Update Codex.
2. Run `codex mcp logout kody`, then `codex mcp login kody`.
3. If two Codex processes still prompt together, update Kody — overlapping
   refreshes on one shared client should stay signed in.

If it still happens about every hour or every new Codex launch, that is the host
skipping refresh. Cursor and Claude Code stay logged in. Email
[`support@kody.codes`](mailto:support@kody.codes) with your Codex version and
how often it asks again if you want us to look.

## Authorizing from a remote or headless machine

Codex, OpenCode, and the Kody CLI finish OAuth on a loopback callback on the
machine they run on. On a remote VM or NAS, the browser on your computer cannot
reach that callback, so login stalls or the final page fails to load. Kody does
not offer a device-code login, and Kody API tokens (`kody_at_`) are not accepted
on `/mcp`, so a static bearer header is not an option.

**Codex**

1. On the remote machine, run `codex mcp login kody --no-browser`.
2. Open the printed link in the browser on your own computer and approve.
3. Copy the final redirected URL from the address bar (it fails to load; that is
   expected) and paste it into the remote terminal.

Or pin the callback port in `~/.codex/config.toml` and forward it:

```toml
mcp_oauth_callback_port = 5555
```

```bash
ssh -L 127.0.0.1:5555:127.0.0.1:5555 user@host
codex mcp login kody
```

See the Codex
[`mcp login` source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs)
and [config reference](https://developers.openai.com/codex/config-reference).

**OpenCode**

OpenCode has no device-code flow for MCP. Its config schema documents the
callback as `http://127.0.0.1:19876/mcp/oauth/callback` (port `19876`). If you
set `oauth.callbackPort` (or `callback_port`) for `kody`, forward that port
instead. Pinning a port also keeps newer builds from picking a random one.

```bash
ssh -L 127.0.0.1:19876:127.0.0.1:19876 user@host
opencode mcp auth kody
```

Without a tunnel, approve in your own browser, copy the final callback URL from
the address bar, and request it on the remote machine while
`opencode mcp auth kody` is still waiting:

```bash
curl 'http://127.0.0.1:19876/mcp/oauth/callback?code=...&state=...'
```

See OpenCode's [MCP servers docs](https://opencode.ai/docs/mcp-servers/) and
[config schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/mcp.ts).

**Kody CLI**

`kody login --no-browser` prints the link but still waits on the loopback
callback at `http://127.0.0.1:43742/callback`. Forward that port first:

```bash
ssh -L 127.0.0.1:43742:127.0.0.1:43742 user@host
kody login --no-browser
```

Or skip the browser login. From an agent already connected to Kody, ask it to
run `cliCredentialBootstrap`, then on the remote machine run
`kody auth bootstrap --code <code>`. For scripts and CI, set `KODY_API_TOKEN`.
See the
[CLI README](https://github.com/kody-hq/kody/blob/main/packages/cli/README.md).

Keep every callback bound to `127.0.0.1`. Forward ports over SSH only, and never
expose a callback port on a public interface.

## Authorize says the request is missing its original connection details

The authorize page needs the original OAuth query (`client_id`, `state`, PKCE).
Clicking Approve before that page finishes loading can replace those parameters
with an empty honeypot field, and the server then asks you to start over. Use
the browser Back button when the previous history entry still has `client_id` in
the URL, or start the connection again from your client.

## Authorize says Kody couldn't load the app's details

Before you can approve, Kody downloads the host's Client ID Metadata Document
(the short description of the app from the app's own website). When that fetch
fails (`metadata_fetch` — timeout, 404, network error, or an invalid document),
the authorize page says so and offers **Retry**. The problem is on the app's
side, not your Kody account, and it is often temporary.

- **Codex CLI:** sign in with dynamic registration instead. Replace `<server>`
  with the name from `codex mcp list`:
  `codex mcp login <server> --oauth-client-registration dcr`.
- **Codex app or ChatGPT:** there is no DCR switch. Wait a few minutes and
  retry.

A different card, **This connection is not registered**
(`missing_registration`), means the app reused a sign-in Kody does not have. Log
out of Kody in the app and sign in again, or remove Kody and add it again. On
Codex CLI that is `codex mcp logout <server>` then `codex mcp login <server>`.

## The host never opens the Kody authorize window

Dynamic OAuth needs the host to open `/oauth/authorize`. If Admin add-connection
succeeds but enabling the MCP tool in chat never opens that window, retry from
another browser or device. That is a host or environment issue, not a failed
Kody registration. In Open WebUI, do not set an OAuth MCP tool as a model
default or pre-enabled tool — enable it in the chat so the host can open the
authorize window. Hosts that require a pre-registered Client ID and Client
Secret can mint one at Account → Agents → Advanced → MCP OAuth clients
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
  `allowed_packages` grant (or adoption after review). When a credential's
  `allowed_packages` list is non-empty and leaves a package out, that package is
  denied when it is reached through another package or imported in a one-off
  execute run, even if you authored or adopted it. A self-authored or adopted
  package that runs on its own still uses the credential; publish and save warn
  about it. Approve the package on the secret's page or move the use into a
  package already on the list. See
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
