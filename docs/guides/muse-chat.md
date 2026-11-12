---
id: muse_chat
title: Connect Muse chat to Kody
summary:
  Connect Meta Muse chat to Kody over MCP with a custom connector and a
  pre-registered OAuth client. Covers the exact redirect URIs, the search-only
  proof step, and the failures to check before diagnosing scope or grants.
category: platform
---

# Connect Muse chat to Kody

Muse chat (Meta's Muse assistant at [muse.ai](https://muse.ai); the older
agent.meta.ai address redirects there) can use Kody over MCP, but it has no
native MCP server settings screen, and it is not the same host as Muse Code.
Muse Code connects from a machine with `~/.config/muse/settings.json` and
`muse mcp login kody` (see the Muse Code entry in the
[host notes](../use/connect-your-agent.md)). Do not follow those instructions
for Muse chat, and do not paste `npx @kodycodes/cli install` into Muse chat:
that runs in Muse's Linux VM and cannot configure Muse Code on your machine.

Muse chat connects through a custom connector: Muse builds a small MCP client
for Kody's hosted MCP server and stores the OAuth credential in its Secure
credentials store. The client speaks Streamable HTTP, and every tool call is
gated behind an explicit allowlist.

This guide covers the search-only setup. `execute` is a deliberate opt-in after
search works, not part of the default setup.

## What approving access means

Approving an agent gives it full access to that Kody account, not a limited
permission set. You can revoke it on Kody's Agents page at `/@<slug>/-/agents`,
where `<slug>` is your Kody username. One MCP connection binds one org.

Kody's MCP server offers `search`, `execute`, and `api`. For this setup,
allowlist `search` first and prove it before considering anything else. Do not
allowlist `api`: it calls Kody API operations directly, including writes and
token operations such as `tokenCreate`, and it is out of scope for a first
connection.

## Prerequisites

- A Kody account, signed in, with a verified email address. Authorize cannot
  finish until the account email is verified.
- A Muse account.
- No API key is involved. Kody's MCP server is OAuth-only; Kody API tokens do
  not work on `/mcp`.

## 1. Pre-register a static OAuth client on Kody

Muse's custom-connector flow asks you to supply a Client ID and Client Secret in
its Secure credentials store; it does not complete dynamic client registration
for you. Kody's MCP OAuth clients page exists for exactly this case: it
pre-registers a confidential client for a host that cannot finish dynamic OAuth
registration. Open Workspace → Agents, then **MCP OAuth clients** in the
**Advanced** panel (`/account/mcp-oauth-clients`).

Under **Create a client**, set **Label** to something you will recognize (for
example `Muse chat`). In **Redirect URIs**, enter these two values, one per
line:

```text
https://muse.ai/api/hatch/oauth/callback
https://agent.meta.ai/api/hatch/oauth/callback
```

Copy them exactly. Kody accepts only a redirect URI that matches one saved on
the client, and a different callback is the most common failure in this setup
(see Troubleshooting). The `agent.meta.ai` callback is the one this setup was
first proven with; Muse has since moved to muse.ai, which serves the same
`/api/hatch/oauth/callback` path. Registering both keeps the client working
whichever one Muse sends.

Select **Create client**. Kody shows the Client ID and Client secret once under
**New client credentials** and does not store the secret after you leave the
page. Keep them for step 2 only, and never paste them into chat.

Do not confuse this page with two other Kody pages:

- **Your clients**, further down the same page, lists the OAuth clients you
  registered. A client existing there does not by itself prove an agent grant.
- **Agents** (`/@<slug>/-/agents`) lists inbound agents granted access. A Muse
  entry there may be for Muse Code, not Muse chat, so read its connection
  instructions before concluding that Muse chat is granted.

## 2. Ask Muse to create the custom connector

Ask Muse to create a custom connector for Kody with these details. They are the
values for [kody.codes](https://kody.codes), whose MCP URL is
`https://kody.codes/mcp`:

```json
{
	"provider": "kody",
	"auth_scheme": "oauth2_code",
	"issuer_domain": "kody.codes",
	"authorization_url": "https://kody.codes/oauth/authorize",
	"token_url": "https://kody.codes/oauth/token",
	"token_endpoint_auth_method": "client_secret_basic",
	"scopes": "openid profile email",
	"resource": "https://kody.codes/mcp",
	"api_hosts": ["kody.codes"]
}
```

On another deployment (a preview or a self-hosted Kody), replace every
`kody.codes` value above (`issuer_domain`, `authorization_url`, `token_url`,
`resource`, and `api_hosts`) with that deployment's host, and register the
client in step 1 on that same deployment. Every deployment publishes its OAuth
endpoints at `/.well-known/oauth-authorization-server` if you want to confirm
them.

Muse will open its Secure credentials store. Enter the Client ID and Client
secret from step 1 there, and nowhere else. Muse then redirects to Kody's
authorize page. Sign in if needed, approve access, and the connection is stored.

## 3. Prove it with a harmless read

Do not start with `execute`, and do not allowlist a tool before its schema has
been returned. Ask Muse to list tools first, then run the harmless search that
Kody's own onboarding guide uses:

```text
list-tools
search({ entity: "guide:onboarding" })
```

Success looks like: `list-tools` returns `search`, `execute`, and `api` with
their input schemas, and the search returns the onboarding guide, which
describes Kody as your agents' cloud (not a gateway) and starts by moving what
is already in the agent into Kody, with six first-win ideas as the fallback.
Only `search` needs to be allowlisted to reach this point.

## What failed on the first attempt

Three failures shaped this guide. Each looked like a different problem until the
error itself was read:

1. **Wrong redirect URI.** The first client was registered with an older example
   callback instead of the `hatch` callback above. Authorize failed with
   `Invalid redirect URI` before any consent screen appeared. The fix was a new
   client with the exact `hatch` callback, not an edit to the old client.
2. **A 403 that was not a Kody refusal.** `list-tools` returned HTTP 403, which
   first read as a scope, audience, or agent-grant problem. The error body was
   Cloudflare Error 1010, `browser_signature_banned`: the edge had blocked the
   client's signature before the request ever reached Kody, so no token, scope,
   or grant diagnosis applied. See Troubleshooting.
3. **A Muse entry that was the wrong host.** The Agents page showed a connected
   Muse entry, which first read as proof that Muse chat was granted. Its
   connection instructions were for Muse Code. A connection marked connected,
   and an Agents entry, do not prove that Muse chat tools work; only the proof
   step in step 3 does.

## Troubleshooting

### Invalid redirect URI at authorize

This is a pre-consent check: Kody compares the `redirect_uri` Muse sends against
the Redirect URIs saved for that exact Client ID. If none matches exactly,
authorize fails before any consent screen with
`Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.`

Fix: create a client with both `hatch` callbacks from step 1, and enter that
client's ID and secret in Muse's Secure credentials store. Kody's MCP OAuth
clients cannot be edited, so if the saved redirect is wrong, select **Revoke**,
then **Revoke now**, on the old client under **Your clients** and create a new
one rather than trying to change it in place.

### HTTP 403 on list-tools

Read the error body before diagnosing scope, audience, or grants. A 403 from
Cloudflare, not from Kody, has a body like `error code: 1010` in plain text, or
JSON like this:

```json
{
	"type": "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/",
	"title": "Error 1010: Access denied",
	"error_name": "browser_signature_banned"
}
```

That error means Cloudflare blocked the request based on the client's signature
before it ever reached Kody. A library default User-Agent (for example Python's
`Python-urllib/3.x`) can trigger it. Cloudflare recommends a descriptive
User-Agent that identifies the client instead. If Muse does not provide a way to
configure that header, contact the deployment owner to review the Cloudflare
rule; do not spoof a browser User-Agent to evade the block.

Once the error body is from Kody rather than Cloudflare, the usual MCP OAuth
distinction applies: 401 means a missing, invalid, or expired token (Kody's 401
carries a `WWW-Authenticate: Bearer resource_metadata=...` header), and 403
means a valid token that lacks the required scope or resource audience.

### The connection is marked connected, but tools still fail

Check, in order: the error body (Cloudflare vs Kody, above), whether the client
is the one whose redirect matches the `hatch` callbacks, and whether the Agents
page entry you are reading is for Muse chat or for Muse Code. A Muse Code entry
does not prove a Muse chat grant.

## Security notes

- Never put a Client Secret, token, password, or cookie in a doc, a helper, a
  command argument, an environment variable, or a log, and never paste one into
  chat. The Secure credentials store is the only place for it.
- A redirect URI from a browser address bar is not a secret and is safe to share
  when diagnosing a redirect mismatch.
- Keep `execute` and `api` out of the allowlist until search is proven and you
  have separately decided you want writes. Approving an agent already gives full
  account access; the allowlist is the second, narrower gate you control.
