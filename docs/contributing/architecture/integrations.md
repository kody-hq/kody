# OAuth integrations (apps and connections)

Saved third-party OAuth config is a first-class primitive: an **OAuth app**
(shared client credentials and provider endpoints) plus one or more
**connections** (connected accounts that share that app). An app lives in one of
two lanes: **user lane** — a per-user `user_oauth_apps` row the user registered
with the provider — or **platform lane** — an operator-provisioned built-in
`platform_oauth_apps` row (see
[Platform (built-in) OAuth apps](#platform-built-in-oauth-apps)). New built-in
connects are limited to enabled + published apps; everything else is
bring-your-own. Per-user access and refresh tokens live encrypted on the
connection (`access_token_encrypted` / `refresh_token_encrypted`). User-lane
client secrets live encrypted on the app (`client_secret_encrypted`). Those
values are not stored in `secret_entries` and do not appear on
`/@<slug>/-/secrets`, `secretList`, or search. Authenticated fetch attaches
`{{integration-token:<connection-name>}}`; the fetch gateway resolves that
placeholder from connection ciphertext.

Data access lives under `packages/worker/src/integrations/`. MCP capabilities
live under `packages/worker/src/mcp/capabilities/integrations/`. The hosted
connect UI is `/connect/oauth`.

## App / connection split

An **OAuth app** (`user_oauth_apps`) holds the provider client identity and
endpoint config that many connections can share:

- `client_id` (inline non-secret identifier)
- `client_secret_encrypted` (user-lane AES-GCM ciphertext; purpose
  `user-oauth-client-secret`; absent for public PKCE apps)
- `token_url`, optional `authorize_url` / `api_base_url`
- `flow` (`pkce` | `confidential`), optional `use_pkce`, `token_exchange_style`,
  `scope_separator`, and `extra_authorize_params_json`

A **connection** (`user_integrations`) is one connected account on an app in
either lane:

- `name` (canonical integration key agents pass to `createAuthenticatedFetch`)
- exactly one of `app_slug` (composite FK to the owning user-lane app) or
  `platform_app_slug` (FK to `platform_oauth_apps(slug)`), enforced by a `CHECK`
  constraint
- `scopes_json`, `required_hosts_json`
- `access_token_encrypted` / optional `refresh_token_encrypted` (AES-GCM;
  purposes `user-oauth-access-token` / `user-oauth-refresh-token`)
- `usage_mode` (`any` | `packages`) and `allowed_packages_json` (user-gated
  grant: `any` is execute plus every package; `packages` is only the listed
  saved package ids, and execute is denied)
- optional `account_label` / `description`, plus connect/refresh timestamps
- `connected_at` — set on platform-lane connection upsert, on every successful
  token persist (`COALESCE` so refreshes keep the first connect time), and by
  migration `0140-backfill-integration-connected-at.sql` for live rows that
  already held tokens. Credential list status and candidate resolution both
  treat `connected_at IS NOT NULL` as connected
  (`packages/worker/src/integrations/connected.ts`); auth failure is a separate
  list-status overlay.
- `provider` — derived from the OAuth app slug via `providerFromSlug`
  (`packages/worker/src/integrations/provider-from-slug.ts`). Collapse into a
  parent family only when that family is a known provider mark
  (`google-calendar` → `google`); compound products whose first segment is not a
  mark keep the longest known mark prefix (`kody-exchange-work` →
  `kody-exchange`) so package credential needs match. Migration
  `0141-fix-compound-provider-marks.sql` restores truncated user and platform
  rows, including suffixed account names.

`JoinedIntegration` (`packages/worker/src/integrations/types.ts`) joins a
connection to the app that owns its client credentials as a discriminated union
with `lane: 'user' | 'platform'`, matching which slug column is set.

The split exists so rotating client credentials is one write on the shared app
instead of one write per connection. Multiple Google accounts share one app; `x`
and `x-kodykoala` share one app when their app-level fields match. Two
connections that share a client id and the same provider endpoints reuse one
app.

Composite primary keys `(user_id, slug)` / `(user_id, name)` and the composite
FK `(user_id, app_slug) → user_oauth_apps(user_id, slug)` keep per-user
isolation structural. Both connection FKs use `ON DELETE RESTRICT`, so
connections must be removed before their app (user lane) and a platform app
cannot be deleted while any user's connection references it. Platform-lane
connections point at a global app row, but the connection itself and its token
ciphertexts stay scoped by `user_id`, so per-user isolation is unaffected.
Disconnect deletes that connection row and its token ciphertext, not a sibling
connection's shared user-lane client secret. Deleting the app removes the
client-secret ciphertext.

## Platform (built-in) OAuth apps

`platform_oauth_apps` (migration
`packages/worker/migrations/0004-platform-oauth-apps.sql`) holds
operator-provisioned OAuth app registrations. The table is global (no `user_id`)
— operator config like feature flags, not user data — so it is not a
per-user-isolation exception. Rows are keyed by `slug` and carry `provider`,
`label`, the inline non-secret `client_id`, `client_secret_encrypted`, endpoints
(`token_url`, `authorize_url`, `api_base_url`), flow options (`flow`,
`use_pkce`, `token_exchange_style`, `scope_separator`,
`extra_authorize_params_json`), the scope menu, `required_hosts_json`,
`enabled`, and `visibility`.

### Enabled and visibility

Two independent switches decide what a platform app does:

- `enabled` is the hard kill. A disabled app accepts no new connects and does
  not resolve for existing-connection paths that require an enabled app.
- `visibility` (`draft` | `published`, migration
  `0075-platform-oauth-app-visibility.sql`, default `draft`) decides
  discoverability. Only **enabled + published** apps
  (`listDiscoverablePlatformOauthApps` / `getDiscoverablePlatformOauthApp` /
  `isPlatformOauthAppDiscoverable` in `platform-apps.ts`) appear on onboarding
  Step 2, the account Integrations **Connect with Kody** section, the
  `/connect/oauth` chooser, and `integrationPlatformAppList`, and only they
  accept new connects, in-lane reconnects, and add-account connects.

A draft app keeps serving the connections users already have (fetch and
host-side refresh), but it is hidden from discovery and its reconnect is
bring-your-own. Never disable an app to hide it: that breaks existing
connections. Move it to draft instead.

Onboarding features a short ordered allowlist in code
(`onboardingFeaturedPlatformIntegrationSlugs` in
`packages/worker/src/app/platform-integration-catalog.ts`). A listed slug still
has to be published and enabled to appear. The account catalog shows every
discoverable app. Both drop apps the user already connected and apps whose slug
is already a connection name.

### Shared client secret stays server-side

The shared client secret is stored encrypted in
`platform_oauth_apps.client_secret_encrypted` (AES-GCM keyed off
`SECRET_STORE_KEY` with the dedicated purpose `platform-oauth-client-secret`;
`encryptPlatformOauthClientSecret` / `decryptPlatformOauthClientSecret` in
`packages/worker/src/mcp/secrets/crypto.ts`). It is deliberately **outside** the
user secret store (`secret_entries`): no `{{secret:…}}` placeholder can name it,
so sandboxed code has no resolution path to the shared credential.

**Invariant:** `getPlatformOauthAppClientSecret`
(`packages/worker/src/integrations/platform-apps.ts`) is the only decrypt
accessor. Its callers are host-side token refresh (`integrationTokenRefresh`)
and the `/connect/oauth` `oauth_exchange` action for a discoverable app. That
exchange takes every input from the app row (token URL, flow, exchange style),
pins `client_id`, and drops any caller-supplied `client_secret`, so a request
cannot point the shared secret at another token URL. The decrypted value must
never appear in capability outputs, loader payloads, or logs. Public projections
(`platform-app-shared.ts`) expose at most a `hasClientSecret` boolean.

### Scope menu

Platform apps carry two scope lists: `allowed_scopes_json` is the verified scope
superset a connection may ever request (the menu shown when a user edits
scopes), and `default_scopes_json` is the minimal set the connect flow requests
during onboarding. Saves fold default scopes into the allowed set.

### Host-side token refresh

Both lanes refresh host-side by default through `createAuthenticatedFetch`.
`integrationTokenRefresh` (implemented by `refreshIntegrationTokens` in
`packages/worker/src/integrations/token-refresh.ts`) resolves the refresh token
and client secret server-side, POSTs to the provider token URL, persists rotated
tokens on the connection, and returns only
`{ ok, refreshed, skippedReason, refreshedAt, refreshTokenRotated }` — never
token values. Platform connections require this path — the shared client secret
stays on the platform app row. User-lane connections may also refresh through
it. Refresh enforces the connection's `requiredHosts` against the token host.
`integrationSave` cannot add new hosts or retarget `tokenUrl` to an unapproved
host; reconnect at `/connect/oauth` to approve a new destination. Platform-lane
destinations are operator-pinned rows, so no user-secret allowlist applies.

The website can also replace a connection's (or a Key's) hosts:
`POST /account/credentials.json` `{action: 'setHosts'}`
(`credentials/credential-hosts.ts`) requires the credential family's `:write`
permission, accepts public HTTPS host names only, always keeps the app's API
base and token hosts (refresh needs the token host), and commits with a
`credential.hosts_updated` org audit event. There is no capability for it: an
agent that could add a host could send the token anywhere. Platform-lane
connections are refused: reconnect resets them to the app's hosts. Migration
0143 backfilled `api`, `content`, and `notify.dropboxapi.com` onto connections
whose app mints tokens at Dropbox's token endpoint
([Dropbox guide](../../guides/providers/dropbox.md)); support can check a
connection's hosts with the `adminOauthConnectionHostsList` capability.

Each `/connect/oauth` token persist writes `user_integrations.refresh_policy`
from the provider token response (`refresh-policy.ts`): `required` when it
carries a refresh token or an access-token expiry (`expires_in` / `expires_at`),
otherwise `not_applicable`. Reconnect overwrites it; a successful refresh stamps
`required`; `NULL` (no token persisted yet) behaves like `required`. A
`not_applicable` connection is a non-expiring grant (for example a GitHub OAuth
App with token expiration off): refresh returns `refreshed: false` without
calling the provider, `createAuthenticatedFetch` hands back the original 401
instead of retrying, and a stale `missing_refresh_token` snapshot is hidden from
every surface. There are no app- or provider-level refresh defaults; see
[decision 0052](../decisions/0052-oauth-refresh-policy-from-token-response.md).

Reconnectable caller-errors (`IntegrationTokenRefreshCallerError`: missing
refresh token on a `required` connection, provider HTTP 4xx / `invalid_grant`,
user-lane missing secrets, host-approval gaps, invalid connection config)
persist a last-failure snapshot on `user_integrations` (`auth_failed_*`) and
best-effort dispatch `integration.auth.failed` to the owning user's packages
that declare the topic. Successful refreshes and successful `/connect/oauth`
token persists clear that snapshot and dispatch `integration.auth.succeeded`.
Sequential classified attempts each emit; the platform does not coalesce those
repeats. Concurrent in-flight refreshes of the same connection share one
provider POST, persist, and event so a 401 stampede cannot rotate the refresh
token out from under itself. Within an isolate they share one promise; across
isolates a lease on `user_integrations` (claimed by compare-and-swap on
`token_refreshed_at`) admits one refresher, and the others return the token it
stored without calling the provider. Provider HTTP 5xx and token endpoint
timeouts persist `provider_unavailable` for Integrations / `integrationGet`
without emitting failed and without a Waiting card. Missing connections do not
write or emit failed. Both payloads are metadata-first (connection name, lane,
account label, description, scopes, connect/refresh timestamps, and for failed:
reason, optional provider error fields, trusted `reconnect_url` and
`account_url`; for succeeded: `source` and trusted `account_url`) and never
include token or secret values. When `account_label` is an email,
`reconnect_url` includes `loginHint` so the provider account chooser can
preselect it. A successful Google refresh that still has no `account_label`
persists `userinfo.email` onto the connection. See
[Package subscriptions](../../guides/package-subscriptions.md).

On 401, `createAuthenticatedFetch` calls `integrationTokenRefresh` then retries
with a `{{secret:…}}` placeholder `Authorization` header, so raw tokens never
enter the sandbox heap. Package code that triggers refresh through
`createAuthenticatedFetch` does not need a secret-write (`allowed_packages`)
grant — the system persists rotated tokens host-side and the package never sees
or writes token values. Host-side refresh returns metadata only; there is no
raw-token helper. The integration usage grant (`any`, or `packages` that
includes that package) decides whether a package — including an unadopted
community fork — can refresh tokens. Token-exchange request building is shared:
`packages/worker/src/integrations/oauth-token-exchange.ts` lives in the
shared-primitive layer so both the `/connect/oauth` handlers and the MCP refresh
capability use it within the import boundaries.

### Provider logos

Operators may attach a logo per platform app (`adminPlatformOauthAppSave`
`logoBase64`; `null` clears). Uploads accept SVG, PNG, JPEG, or WebP. The shared
community-icon pipeline sanitizes SVG, then Cloudflare Images fits every
accepted source to a 256-pixel WebP (`fit: scale-down`, quality 90), so a newly
ingested asset is stored and served as WebP. GET paths whose stored object
predates ingest fitting (`iconFitVersion` other than `2`) rewrite the hashed key
in place; if Images fails they fall back to the original bytes so the mark still
renders. Assets live in the `COMMUNITY_ASSETS` R2 bucket under content-hashed
`platform-oauth-app-logos/{slug}/` keys (operator-owned, like the app row);
`platform_oauth_apps.logo_key` / `logo_content_type` point at the current asset.
Serving is the public `/integrations/logos/:integrationSlug` route with
immutable caching; projections expose the relative `logoPath`. The connect page
and account integration views render it, falling back to the operator-curated
provider mark, then the auto-favicon, then the letter.

User-lane OAuth apps have the same asset pipeline on `user_oauth_apps`
(`logo_key`, `logo_content_type`, `logo_source`, `favicon_source_host`).
`integrationSave.logoBase64` is omit / value / `null` like the platform field.
When no explicit upload is stored, connect and account-page loads fetch the
registrable-domain favicon of `authorizeUrl` (then `apiBaseUrl` / `tokenUrl`)
over HTTPS with manual redirects, prefer `apple-touch-icon` then `rel=icon`,
accept `/favicon.ico` only when it embeds a PNG, and store a raster under
`user-oauth-app-logos/{userId}/{slug}/`. Display order is explicit upload,
operator-curated provider mark, auto-favicon, then the letter fallback.
User-added MCP servers on `/@<slug>/-/mcp-servers` use the same order (matched
by server name or `url` host). The same `/integrations/logos/:slug` route serves
user assets only to the signed-in owner after a platform miss.

Operator-curated provider marks live in `platform_provider_marks` (slug, label,
aliases, logo). Operators add them on `/admin/provider-marks` or through
`adminPlatformProviderMarkSave` / `_list` / `_delete` so a Google (or any other)
brand mark is data, not a deploy. Matching prefers an exact slug, then a stored
or built-in alias (`google-youtube-brand` → `youtube`, `nodejs` → `nodedotjs`),
then the longest family key (`github-kent` → `github`, `x-kodykoala` → `x`),
then an authorize-host token. The slug itself is a host label (`api.github.com`
matches `github`) unless the token is shorter than three characters or a generic
TLD (`com`, `app`). Host fallback prefers an exact or suffix alias over a slug
label so `mail.google.com` uses `gmail` rather than `google`. Built-in keys and
hosts live in `default-provider-mark-aliases.ts` so a catalog row that omitted
`github.com` still resolves. Saves strip those built-ins from stored aliases;
the admin editor lists them as read-only. Assets use the same SVG/PNG/JPEG/WebP
ingest pipeline under `platform-provider-marks/{slug}/` and serve at the public
`/integrations/provider-marks/:slug` route. Login and onboarding use the inline
`ProviderIcon` set. The admin catalog page groups marks by first letter and
opens the editor inside the selected group so a multi-thousand-mark catalog does
not render every tile at once.

### Admin provisioning

Operators manage platform apps through role-gated capabilities in the `admin`
domain, all audited via `auditAdminCapabilityInvocation`:

| Capability                        | Role                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adminPlatformOauthAppSave`       | Create/update; plaintext `clientSecret` stored encrypted, never returned; optional `visibility` (omit keeps it); optional `newSlug` renames in place (secret, logo, and user connections carry over atomically) |
| `adminPlatformOauthAppList`       | Includes `hasClientSecret` and per-app user connection counts                                                                                                                                                   |
| `adminPlatformOauthAppDelete`     | Fails while user connections reference the app — disable (`enabled = 0`) instead                                                                                                                                |
| `adminPlatformProviderMarkSave`   | Create/update a brand mark (slug, label, aliases, `logoBase64`) used after an explicit upload and before auto-favicon on integrations and MCP servers                                                           |
| `adminPlatformProviderMarkList`   | Lists marks with serving paths; no user data                                                                                                                                                                    |
| `adminPlatformProviderMarkDelete` | Deletes the mark row and its R2 asset                                                                                                                                                                           |

Confidential apps require a stored client secret only while `enabled`. An agent
can therefore stage a complete provider config through `save` with
`enabled: false` and a placeholder client id; the operator pastes the real
client id and secret in `/admin/platform-integrations` and enables it. The
enable transition re-validates, so a secretless confidential app can never
become reachable. `/admin/platform-integrations` shows each app's visibility and
has separate **Publish** / **Move to draft** and **Enable** / **Disable**
controls.

## Where credentials live

| Field                         | Storage                                       | Notes                                               |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Client id                     | `user_oauth_apps` / `platform_oauth_apps`     | Non-secret OAuth client identifier                  |
| Client secret (user lane)     | `user_oauth_apps.client_secret_encrypted`     | AES-GCM; never listed as a user secret              |
| Client secret (platform lane) | `platform_oauth_apps.client_secret_encrypted` | Encrypted at rest; never placeholder-named          |
| Access token                  | `user_integrations.access_token_encrypted`    | AES-GCM; resolved as `{{integration-token:<name>}}` |
| Refresh token                 | `user_integrations.refresh_token_encrypted`   | AES-GCM; host-side refresh only                     |

Access and refresh tokens are per-user ciphertext on the connection in **both**
lanes. Account export includes both per-user tables; rows contain the inline
`client_id` and never encrypted secret payloads. Exporting `client_id` is
deliberate: it is a non-secret OAuth client identifier, not a credential value.
`platform_oauth_apps` is global operator config and is not part of any user's
export.

## Two independent host gates

Outbound OAuth calls enforce two allowlists that are not collapsed:

1. **Connection `requiredHosts`** (plus the host of `apiBaseUrl`) — enforced by
   `createAuthenticatedFetch` / `assertIntegrationHostAllowed` before an OAuth
   bearer token is attached. A materialized token is not a `{{secret:…}}`
   placeholder, so the fetch gateway cannot apply secret host policy to it.
2. **Each secret's `allowedHosts`** — enforced when secret placeholders resolve
   through the fetch gateway (client secret on token exchange, token mounts, and
   similar paths).

Both must allow a destination for the full connect → refresh → API call path to
succeed. See the
[OAuth integration host allowlist](./index.md#oauth-integration-host-allowlist)
note on the architecture index.

## `/connect/oauth` and authenticated fetch

`/connect/oauth` runs authorize → callback → token exchange in the browser
session, writes access/refresh tokens as ciphertext on the connection, and
upserts the app + connection via the integrations service. A signed-in visit
with no `provider` renders a chooser of saved connections that can start from a
name alone, followed by discoverable built-ins the user has not connected yet.
`/connect/oauth?provider=<slug>&platform=<slug>` starts a built-in connect: the
lookup resolves the discoverable app, the page clamps requested scopes to the
app's allowed menu, and `oauth_exchange` / `connect_oauth` take endpoints,
hosts, and credentials from the app row (`connect_oauth` re-validates scopes
before persisting tokens). A `platformAppSlug` for a draft or disabled app is
a 400. Existing connections on a discoverable app reconnect in-lane; connections
on a draft or disabled app stay listed so their tokens keep refreshing, but
reconnect is bring-your-own: `?provider=<name>` prefills endpoints and scopes
and asks for the user's own client credentials. Reconnect with
`?provider=<integration-name>` reuses saved authorize metadata (scopes,
`scopeSeparator`, `extraAuthorizeParams`) from a user-lane app.

RFC 8628 **device authorization** is one server backend with two entry points:
`device_start` / `device_poll` on `/account/secrets.json` (browser
`/connect/oauth?flow=device`) and MCP `integrationDeviceConnectStart` /
`integrationDeviceConnectPoll`. Shared resolve + persist lives in
`packages/worker/src/integrations/device-connect.ts` and
`connect-oauth-persist.ts`. The provider `device_code` and client secret never
leave the server; callers see an opaque session id, `user_code`, and
verification URI. App config stores optional `device_authorization_url`
additively — existing rows need no backfill.

The hosted page leads with the provider mark, credentials or a connect button, a
terms note, and a **Change scopes** disclosure. Endpoints, host allowlists, and
stored config stay behind an advanced disclosure. A `?provider=` visit that
cannot resolve authorize and token URLs offers a copy-prompt for an agent.

`createAuthenticatedFetch(providerName)` (execute runtime helper) loads the
named connection joined to its app, refreshes the access token when needed, and
returns a fetch wrapper that:

1. asserts the request host against the connection allowlist
2. attaches the bearer token only after that check passes

Capability and search detail surfaces keep a **flat connection-shaped** config
(`clientId`, endpoints, `authorization`, `requiredHosts`) so callers do not need
to join app and connection themselves. Search does not list token or
client-secret values.

## Account UI

`/@<slug>/-/integrations` is a list of integrations (the services you connect:
Google, GitHub). Selecting a row shows that integration and the connections
(signed-in accounts) on it. Each connection shows how many scopes it requests
versus the built-in menu when one exists, and a copy-prompt asks an agent to
widen the integration's reconnect scopes (then ask the user to reconnect).
Existing built-in connections show a small “Provided by Kody” indicator.
Reconnect and add-account links resolve to the built-in lane while the app is
discoverable and to bring-your-own `/connect/oauth` setup otherwise. A **Connect
with Kody** section lists discoverable built-ins the user has not connected; it
renders nothing while every app is draft. Deep links to a connection
(`/@<slug>/-/integrations/:name`) open the parent integration and highlight that
connection. User-registered integrations also have
`/@<slug>/-/integrations/apps/:appSlug` (a connection named `apps` resolves at
`/@<slug>/-/integrations/apps`). Endpoints, host allowlists, flow / PKCE /
exchange style, and credential rotation stay behind an advanced disclosure. Each
connection also shows a usage grant: **any context** (execute and every package)
or **specific packages** only. Agents tighten that grant with `integrationLock`
(switch to packages mode and add a saved package id; unlocking or removing a
grant is website-only). One-click approval lives at
`/@<slug>/-/integrations/approve?name=&package_id=`; approving a package while
the connection is still `any` leaves it `any` so execute stays usable. The
rotate form posts to `/account/integrations.json` with
`action: "rotate_oauth_app_credentials"`: it stores a new client-secret value on
the app, then calls `rotateOauthAppClientCredentials` so every sibling
connection picks up the new client id on the next join. Each connection has a
double-checked Disconnect control; user-registered integrations also have Delete
integration. Both are delayed-commit undoable actions (`createUndoableAction`):
the UI updates immediately, and `/account/integrations.json` receives
`disconnect_connection` or `delete_oauth_app` only after the undo window (or
when the user leaves). Built-in apps cannot be deleted; disconnect their
connections instead.

## Capability surface

Domain: `integrations`
(`packages/worker/src/mcp/capabilities/integrations/domain.ts`).

| Capability                                       | Role                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `integrationSave` / `_get` / `_list` / `_delete` | Connection CRUD with flat `clientId` output                                        |
| `integrationLock`                                | Tighten-only usage lock: packages mode + add a package id; unlock is website-only  |
| `integrationOauthAppList`                        | Apps with connection counts and sibling connection names                           |
| `integrationOauthAppDelete`                      | Delete a user-lane app and every connection on it                                  |
| `integrationOauthAppRotateCredentials`           | Rotate shared app `clientId` / client-secret name                                  |
| `integrationPlatformAppList`                     | Discoverable (enabled + published) built-ins; operators use the admin list         |
| `integrationTokenRefresh`                        | Host-side OAuth refresh; returns metadata only, never token values                 |
| `integrationDeviceConnectStart` / `_Poll`        | RFC 8628 device grant; credentials persist server-side; no token/`device_code` out |

## Account deletion order

Deletion targets in `account-data-targets.ts` list `user_integrations` before
`user_oauth_apps` so the `ON DELETE RESTRICT` FK cannot block cleanup when
cascades are disabled. `platform_oauth_apps` is global operator config and is
not a deletion target; removing a user's connections is what releases their
`ON DELETE RESTRICT` references to it.

## Related docs

- [Data storage](./data-storage.md) — D1 inventory and JSON shadow schemas
- [OAuth guide](../../guides/oauth.md) — agent-facing `/connect/oauth` workflow
- [Primitives map](./primitives.yaml) — `integrations` primitive and
  `integration-host-allowlist` invariant
