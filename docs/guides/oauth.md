---
id: oauth
title: OAuth: bring your own app
summary:
  START HERE for third-party OAuth: hosted /connect/oauth, the exact
  redirect URI (https://kody.codes/connect/oauth), required query params,
  PKCE vs confidential, the post-connect copyable agent prompt, and how
  it differs from MCP OAuth.
category: platform
---

# OAuth: bring your own app

Read this guide first for third-party OAuth (GitHub, Linear, Spotify, and
similar providers).

This guide covers the standard hosted OAuth path. Use it before building a
package or package app that depends on the resulting integration or tokens.

For a teaching walkthrough of Google OAuth (Gmail inbox reading) as an
interactive agent transcript, see [google-oauth.md](./google-oauth.md). For
drafts the agent must not send (Google has no drafts-only scope), see
[locked-gmail-drafts.md](./locked-gmail-drafts.md).

## Default path: `/connect/oauth`

A signed-in visit to `https://kody.codes/connect/oauth` with no `provider` shows
a chooser of saved connections that can start from a name alone. Selecting one
updates the URL to `?provider=<name>`. Anonymous visits go to login and return
here.

Kody publishes built-in apps for some providers. `integrationPlatformAppList`
returns the enabled + published ones. If it lists the provider, send
`/connect/oauth?provider=<slug>&platform=<slug>`: the user connects without
registering a provider app, and scopes are limited to that app's allowed menu.
Every other provider uses the bring-your-own path in this guide.

Send the signed-in user to `https://kody.codes/connect/oauth` with query
parameters that describe the provider. The page runs authorize -> callback ->
token exchange in a full browser context and persists access and refresh tokens
on the connection.

This path does not require package-app-specific OAuth code.

Example shape:

`https://kody.codes/connect/oauth?provider=...&authorizeUrl=...&tokenUrl=...`

## Choosing the organization (`org`)

OAuth apps and connections belong to one organization. Add `org=<slug>` to save
the app and connection to that organization:

`https://kody.codes/connect/oauth?org=test-team&provider=github&authorizeUrl=...&tokenUrl=...&flow=confidential`

- The signed-in user must be a member of that organization; otherwise the page
  answers "Organization not found." An empty `org=` is rejected (it never falls
  back to the personal org).
- Saving, rotating, or deleting a team organization's OAuth app needs
  `integration:write` (`integration:delete` to delete). Owners have both;
  members need a grant from an Owner. Connecting an account through an app the
  organization already saved stays open to members.
- Without `org`, single-organization users save to their personal organization.
  Users in more than one organization first pick an organization (personal is
  the default); the page then reloads with `org=<slug>` so it shows that
  organization's saved apps.
- The page always shows which organization it saves to. Lookups (`app=`,
  provider-family prefill) only see apps saved in that organization.

Agents: when setting up for anything other than the user's personal
organization, always include `org=<slug>`. Otherwise the page may find the
personal org's app with the same name and skip the client ID / secret form.

## Connect your own account through an org's app

When a team org has registered an OAuth app, a Member or Owner of that org can
connect **their own** provider account through it, so packages in that org run
with each person's own account:

`https://kody.codes/connect/oauth?org=<org>&app=<app slug>&mode=personal`

The app's page in the org (**Integrations**, then the app) links there as
**Connect your own account**. The page skips the app setup step: the client id
and secret come from the org's app and stay on the server, so the member never
sees or edits them. The connection and its tokens are saved in the member's
personal org, granted to that org only, and used only in the member's own runs
there (never in another org, the member's personal org, another member's runs,
or by Owners or Automation on their behalf). Billing members and outside
collaborators cannot use this mode. Org Owners see each member's connection on
the app's page (member, account label, date; never tokens or scopes) and can
revoke it. Revoking, leaving the org, or deleting the app wipes the connection
and revokes it with the provider: GitHub OAuth Apps through the app's token
revoke endpoint, and providers with an RFC 7009 revocation endpoint through it.
Other providers keep listing the app under the account's authorized apps until
the person removes it there.

## Token refresh

All integrations refresh host-side through `createAuthenticatedFetch`, which
calls `integrationTokenRefresh` on auth failures and retries with a secret
placeholder (raw tokens never enter the sandbox). Auth failure means HTTP 401
for every provider. For Slack integrations it also means HTTP 200 JSON
`{ok:false}` with `token_expired`, `token_revoked`, `invalid_auth`, or
`not_authed` (Slack does not use 401 for dead tokens), and `files.slack.com`
responses whose Content-Type is `text/html` (dead token redirected to login).
Reconnectable refresh failures dispatch `integration.auth.failed` to packages
that subscribe; successful refreshes and `/connect/oauth` persists dispatch
`integration.auth.succeeded` (see
[package subscriptions](./package-subscriptions.md)). Prefer
`createAuthenticatedFetch` for header-based OAuth. There is no raw-token helper:
host-side refresh returns metadata only.

## Redirect URI

The redirect URI is:

`https://kody.codes/connect/oauth`

Register it in the provider console exactly as written. Users connect to Kody at
`https://kody.codes`, so connect URLs use `https://kody.codes/...`. The
`/connect/oauth` page shows the redirect URI for the current origin with a copy
button. A self-hosted deployment uses its own origin plus `/connect/oauth`.

## Provider setup checklist

The provider-side setup is the same for every provider:

1. Create an OAuth app in the provider's developer console.
2. Register the exact redirect URI above.
3. Enable any APIs and scopes the integration needs.
4. Paste the client ID (and client secret for confidential flows) into the
   `/connect/oauth` setup form in Kody.

## Query parameters

| Param          | Purpose                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `provider`     | Required. Short integration label used to derive stored names.                                                                     |
| `authorizeUrl` | Provider authorization endpoint URL. Required for a new provider setup; omitted on reconnect.                                      |
| `tokenUrl`     | Provider token endpoint URL. Required for a new provider setup; omitted on reconnect.                                              |
| `mode`         | `personal` with `org` and `app`: [connect your own account](#connect-your-own-account-through-an-orgs-app) through that org's app. |

For reconnects, `/connect/oauth?provider=<name>` alone is enough — the page
derives the endpoint URLs from the saved integration.

When those URLs are unknown, look them up in the provider's official docs before
building `/connect/oauth`. Verify that every `authorizeUrl` and `tokenUrl`
belongs to the provider's own domain.

The token endpoint host is always included for host approval. Add more API hosts
with `allowedHosts` when needed.

## Common optional parameters

| Param                       | Purpose                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `org`                       | Organization slug that receives the app and connection. Omit only for the personal org; see above.                               |
| `flow`                      | `pkce` (default), `confidential`, or `device` (RFC 8628).                                                                        |
| `deviceAuthorizationUrl`    | Required when `flow=device`: the provider's device authorization endpoint.                                                       |
| `pkce`                      | `true` or `false`; overrides the PKCE default for `pkce` / `confidential` only. Device flow ignores PKCE entirely (no override). |
| `tokenExchangeStyle`        | `form` (default), `basic-json`, or `basic-form`; overrides the host default.                                                     |
| `scopes`                    | Space- or separator-separated scopes.                                                                                            |
| `scopeSeparator`            | Defaults to a single space.                                                                                                      |
| `allowedHosts`              | Extra API hosts beyond the token (and device) host.                                                                              |
| `apiBaseUrl`                | Optional API base URL hint.                                                                                                      |
| `dashboardUrl`              | Provider settings link.                                                                                                          |
| `extraAuthorizeParams`      | Provider-specific authorize params.                                                                                              |
| `loginHint`                 | Merges into authorize `login_hint` without replacing stored extra params.                                                        |
| `providerSetupInstructions` | Free-form setup hints shown in the wizard.                                                                                       |

## Device authorization grant (RFC 8628)

When the provider has no browser redirect (CLI, TV, headless agent), use
`flow=device` and `deviceAuthorizationUrl`. `authorizeUrl` is optional;
`tokenUrl` is still required. Example:

`/connect/oauth?provider=example&flow=device&deviceAuthorizationUrl=https://…/device&tokenUrl=https://…/token&scopes=…`

The connect page starts device authorization server-side (`device_start`), shows
the `user_code` and verification link, and polls (`device_poll`) until approved,
denied, or expired. The provider `device_code` and any client secret stay on the
server. Public device clients need only a client ID; confidential device clients
may also store a client secret.

Agents can drive the same backend with MCP `integrationDeviceConnectStart` /
`integrationDeviceConnectPoll` (outputs never include token values or
`device_code`). Prefer `/connect/oauth` for interactive browser users.

## PKCE and client secrets are orthogonal

`flow` decides whether a client secret is collected and sent (`confidential`) or
not (`pkce`). Device grant allows public clients (no secret) or confidential
ones. PKCE itself is a separate switch: it defaults to on for the `pkce` flow
and off for `confidential`, and `pkce=true` enables S256 PKCE on top of a
confidential flow for providers that require both. Device flow ignores PKCE
entirely — there is no authorize redirect, so `pkce=true` has no effect when
`flow=device`.

`tokenExchangeStyle` decides how confidential credentials reach the token
endpoint: `form` puts `client_secret` in the urlencoded body (GitHub, Slack,
Google), `basic-json` sends HTTP Basic with a JSON body (Notion), and
`basic-form` sends HTTP Basic with an urlencoded body (Canva).

Known host defaults (no extra params needed):

- `api.notion.com`: `basic-json` token exchange.
- `api.canva.com` (Canva Connect): `confidential` flow with S256 PKCE and
  `basic-form` token exchange. Authorize URL is
  `https://www.canva.com/api/oauth/authorize`, token URL is
  `https://api.canva.com/rest/v1/oauth/token`.

The connection name is a normalized slug of `provider`. Access and refresh
tokens live on that connection — not as separately named secrets.

After a successful connection, Kody saves the non-secret OAuth authorization
metadata needed for future reconnects in the integration record:

- `authorizeUrl`
- requested `scopes`
- non-default `scopeSeparator`
- provider-specific `extraAuthorizeParams` such as Google `access_type=offline`
  and `prompt=consent`

For an existing integration, agents can call `integrationGet` or
`integrationList` to inspect this metadata. To reconnect without rebuilding the
full authorize URL by hand, open `/connect/oauth?provider=<integration-name>`;
the page derives the provider authorize URL from the saved integration config
and the current client credentials.

`integrationSave` can widen `authorization.scopes` on a connection. That field
is reconnect metadata — the list the next `/connect/oauth` visit requests — not
the current access token. After saving, tell the user the token is unchanged
until they reconnect, then ask whether to reconnect each affected account.
Scopes are per connection.

A `?provider=` visit that has no stored authorize/token URLs and no query
endpoints shows a copy-prompt so an agent can return a complete connect URL
instead of a dead-end error.

## Integration naming convention

Integration identity is the canonical provider key: names are normalized to
lowercase kebab (letters, numbers, `.`, `_`, `-`) on every save and lookup, so
`GitHub`, `github`, and `Git Hub` all resolve to the same `github` connection.
Each connection is a D1 row in `user_integrations` keyed by `(user_id, name)`. A
connection points at a user-registered OAuth app (`app_slug` →
`user_oauth_apps`). Connections share one `user_oauth_apps` row only when their
entire app-level configuration matches: client credentials, provider endpoints,
flow and PKCE, token exchange style, scope separator, and extra authorize
params. Anything that differs gets its own app. Rotating an app's client
credentials updates every connection sharing it.

Prefer integration names like `<provider>-<purpose>` when multiple accounts may
exist: `google` for a default account, `google-business` for a business account,
or `google-youtube-brand` for a brand identity. Agents should call
`integrationList` up front when a provider may have multiple accounts connected.

Manage integrations from `/@<slug>/-/integrations`. The list is one row per
service; opening a row unfolds its connections in the table. User-registered
integrations also resolve at `/@<slug>/-/integrations/apps/<app-slug>`.
Disconnect a connected account or delete a user-registered integration from that
expanded row — both ask for a second click, then offer Undo for a few seconds.
App metadata and the client-secret rotation form live under Advanced details,
with an explicit confirmation step. Agents can call `integrationOauthAppList`,
`integrationOauthAppDelete`, and `integrationOauthAppRotateCredentials` when
working outside the account UI.

## Not the same as MCP OAuth

`/connect/oauth` is for outbound provider OAuth.

Kody's MCP OAuth endpoints (`/oauth/authorize`, `/oauth/callback`, and related
routes) are for clients authenticating to Kody itself.

## When to use another guide

| Need                              | Use              |
| --------------------------------- | ---------------- |
| API keys or PATs instead of OAuth | `connect_secret` |

## After a successful connect

A saved OAuth integration is **auth credentials only**. It is not an
agent-callable package API.

The `/connect/oauth` success page shows a **What's next?** prompt the user can
copy into their agent. The prompt names the resolved provider and the saved
connection (for example `google` / `google-work`) and asks whether to fork a
public package or build a helpers package. The same prompt is in the `nextSteps`
JSON on the connect success response.

Do not treat connect success as “the Google/GitHub/etc. package is ready.” Next
step is smoke-test auth, then `communitySearch` (preferring `trusted`) or create
a thin helpers package. `search({ entity: "integration:<provider>" })` may
already surface same-provider package suggestions.

## Agent checklist

1. Confirm OAuth is the right auth shape.
2. Build the connect URL with the required params:
   `https://kody.codes/connect/oauth?...`. Add `org=<slug>` when the app is for
   a team organization.
3. Tell the user the exact redirect URI to register:
   `https://kody.codes/connect/oauth`. The page shows it with a copy button.
4. Have the user open the URL while signed in, paste their client ID (and client
   secret when the flow is confidential), and wait for success.
5. Run the authenticated smoke test from `integration_bootstrap`
   (`createAuthenticatedFetch`). Do not persist access or refresh tokens with
   `secretSet` / `secretSetMany`.
6. Use `communitySearch` (preferring `trusted`) to fork/adapt a helpers package,
   or create a thin helpers package when none fits. Continue with dependent
   package apps only after that surface exists and the smoke test passes.

## Package-first recommendation for OAuth integrations

For OAuth integrations with a successful hosted `/connect/oauth` flow and
passing smoke test:

- treat the saved integration as credentials; put agent-facing calls in a
  helpers package (prefer a close public package from `communitySearch`)
- build a package app when the integration needs a hosted UI
- keep provider API calls in package-owned backend code
- keep reusable automation in package exports
- reopen a hosted package app through its hosted package URL
