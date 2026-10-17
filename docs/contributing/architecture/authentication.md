# Authentication

`kody` is multi-user. Each signed-in user has a fully isolated assistant: their
own packages, jobs, secrets, memories, MCP servers, email inboxes, and durable
storage. The auth layer is the boundary that establishes which user a request
belongs to before any handler reads or writes data.

`kody` uses two related authentication models:

1. Cookie-based app sessions for browser users
2. OAuth bearer tokens for MCP access

Hosted package apps are served from a separate origin in production and use a
third, deliberately narrow credential — see
[Package app origin handoff](#package-app-origin-handoff).

Authorization (roles and permissions) is layered on top of authentication. See
[Authorization](./authorization.md) for the RBAC model, admin routes, and the
`any`-access exception for account administration.

## Browser app sessions

Session cookie behavior is implemented in
`packages/worker/src/app/auth-session.ts`.

- Cookie name: `kody_session`
- `httpOnly: true`
- `sameSite: 'Lax'`
- signed with `COOKIE_SECRET`
- default max age: 7 days
- `remember me` login max age: 30 days
- remembered sessions are renewed with a fresh 30-day cookie after 14 days of
  age
- the browser `Max-Age` and `resolveRequestAuth` both enforce that absolute
  lifetime: a cookie whose `issuedAt` plus TTL is in the past is treated as
  signed out and the cookie is cleared. A cookie that omits `issuedAt` is
  rejected the same way.

Referral share links set a separate last-wins `kody_ref` cookie (one week, not
`httpOnly`) so a later `/signup?ref=` overwrites the previous referrer. Signup
persists a `referrals` row from that cookie. See
[Referral Pro credit](./entitlements.md#referral-pro-credit).

The cookie payload stores:

- `v: 2`
- `stableUserId` (the authoritative `users.stable_user_id`)
- `email`
- `issuedAt` (epoch ms when the cookie was issued or last renewed)
- `rememberMe` when the login used remember-me

Password reset confirmation and signed-in password change revoke every MCP OAuth
grant for that user, write `users.password_changed_at`, then revoke again so a
grant created in that window cannot survive. Password-reset confirmation also
disables two-factor authentication, deletes passkeys, and deletes linked sign-in
providers (`oauth_connections`), then emails the owner listing those cleared
methods.

Session resolution rejects cookies whose `issuedAt` is missing or at/before that
timestamp, so a reset invalidates every existing browser and package-app
session. It also rejects cookies past the absolute lifetime (`issuedAt` plus 7
or 30 days) and cookies that omit `issuedAt`, clearing the cookie. A signed-in
change re-issues the current `kody_session` cookie with a later `issuedAt` so
that browser stays signed in and leaves second factors and linked providers in
place. `/mcp` rejects access tokens whose `createdAt` is at or before that
timestamp (`invalid_token`), so already-issued bearers die immediately; hosts
that refresh then hit the revoked grant and must start a new OAuth flow.

`users.id` never crosses the cookie boundary. Session resolution looks up the
stable id and only then uses the numeric primary key for internal D1 joins.
Version-1 cookies fail closed and require a fresh login.

`packages/worker/src/app/handler.ts` calls `setAuthSessionSecret` on each
request so cookie signing and verification are available to handlers.

## Login and signup

`POST /auth` is implemented by `packages/worker/src/app/handlers/auth.ts`.

- Accepts JSON body with `email`, `password`, `mode` (`login` or `signup`), and
  optional `rememberMe` for logins
- Uses D1 (`users` table) for user lookups and inserts
- Hashes passwords with `@kody-internal/shared/password-hash.ts`
- Returns signed session cookie via `Set-Cookie` on success
- Emits structured audit events through `packages/worker/src/audit-log.ts`

### Signup posture

Anyone can create an account from `/signup` (password or social). New accounts
start on the `free` plan. Referral share links (`?ref=`) are a separate growth
program.

Account signup Kit tagging (password and OAuth signup):

- When `KIT_API_KEY` is set and the new account email already exists in Kit,
  apply `signed_up::kody` (optional override `KIT_SIGNED_UP_TAG_ID`)
- Does not create Kit subscribers for people who were never in Kit
- Leaves existing tags alone
- Best-effort only: Kit errors or a missing key never fail account creation

Exist-only Kit subscriber sync (`packages/worker/src/kit/subscriber-sync.ts`)
then keeps tags in step with account facts. Lookup by email; skip if missing;
add lifecycle tags; remove only paid tags on cancel. Call sites: signup, email
verify, first MCP connection, first saved package, Stripe plan refresh, and the
hourly `kit_subscriber_sync` lane. Tags:

- `signed_up::kody`
- `verified::kody`
- `agent_connected::kody`
- `activated::kody`
- `standard::kody` / `pro::kody` (cleared when the Stripe plan is no longer
  paid)

Admins can create a user directly by email from `/admin/users`. That flow calls
`adminCreateUserWithPasswordSetup` in
`packages/worker/src/identity/admin-user-creation.ts` instead of going through
the web route logic directly, so admin MCP capabilities can reuse the same
service. It:

- requires a unique email and either a unique explicit username or an
  auto-generated unique username derived from the email
- stores a sentinel `password_hash` that never verifies as a usable password
- marks `users.email_verified_at` immediately because the admin knows the
  recipient
- creates a `password_resets` token with a 7-day expiry and returns the
  `/reset-password?token=...` setup link to the admin UI
- never sends email automatically; the operator copies the displayed setup link
  into a manual email

There is no privileged "primary user" at runtime. The first admin is still
bootstrapped through SQL; after that, admin role assignment happens through
admin routes.

### Email verification

New signups create an `email_verifications` token row, send a verification link
through `packages/worker/src/app/email/cloudflare-email.ts`, and store
`users.email_verified_at` only after `GET /verify-email?token=...` succeeds.
Verification tokens expire after 24 hours and only token hashes are stored.

Signup fails hard when the verification email cannot be sent: the created user
row is rolled back so the email/username can be retried. An account must never
exist without a way to verify it. The only exception is non-production runtimes
(local dev, preview, test — see `isNonProductionRuntime`) with no Cloudflare
email sender configured; there the send is skipped and accounts are verified
through seeded tokens instead.

Additional email destinations (addresses `emailSend` may use besides
`users.email`) reuse the same 24-hour hashed-token link pattern:
`email_notification_destinations` plus
`pending_email_destination_verifications`, sent from `kody@<apex>`, confirmed at
`GET /verify-email-destination?token=...`. `HEAD` probes inspect the token
without consuming it, so link scanners do not burn an unused link. A successful
`GET` keeps that token until it expires so a repeat click is idempotent; unused
links from earlier resends stay valid until expiry or the address verifies.
Identity email change and release stay on their existing flows; destinations do
not own `users.email`. Add, resend, set-default, and remove live at
`/@<slug>/-/email`, `/account/email-destinations.json`, and the
`emailDestination*` capabilities. Add and resend are limited to 3 requests per
15 minutes per account, 10 verification emails per account per rolling 24 hours,
and 3 verification emails per recipient address per rolling 24 hours across all
accounts (the recipient key is a hash of the normalized address). The account
must be at least 24 hours old (`users.created_at`) before it can request that
mail. Blocked requests name the limit and the UTC time to retry. The address is
still saved when the mail is blocked, so an operator can mark that row verified.
`adminEmailDestinationVerify` does not send mail and is not subject to those
caps. Re-adding a pending unverified address resends a verification email. The
cap is 5 extras besides the identity email. Unverified extras never receive
mail. Destinations expand the verified `to` set only; mail comes from
`{username}@{platform}`. A successful Cloudflare send stores that
`provider_message_id` in `transactional_email_delivery_index` with kind
`email_destination_verification` so later Cloudflare lifecycle events can
attribute bounce, deferred, or delivered to the extra-address message. A newer
send retires only the previous index row for that same recipient, so other
pending extras stay attributable. Those events stay on the index (and the
delivery-alert bounce/complaint table); they do not write
`users.email_verification_delivery_*`.

Signed-in users with an unverified email can request a fresh link with
`POST /account/resend-verification.json`
(`packages/worker/src/app/handlers/account-resend-verification.ts`), surfaced as
a "Resend verification email" button on `/pending-verification`, `/account`,
`/onboarding`, and `/oauth/authorize`. The endpoint reuses
`createEmailVerification` (invalidating older tokens) and is rate-limited per
user (3 requests per 15 minutes).

`users.email_verified_at` records whether an account's email is verified.
Accounts with a non-null value are treated as verified; normal signup leaves it
null until `GET /verify-email?token=...` succeeds. Seeded and test fixture
accounts are created verified. Unverified accounts can sign in and see their
status on `/account`.

Verification mail is sent from `kody@<SYSTEM_EMAIL_DOMAIN>` through Cloudflare
Email Sending and sets `Reply-To: support@<same domain>` so human replies land
on support rather than the transactional sender. Provider accept is not
delivery: the send stores `provider_message_id` in
`transactional_email_delivery_index` with kind `email_verification` and sets
`users.email_verification_delivery_status` to `accepted`. Later Cloudflare
lifecycle events (`delivered`, `deferred`, `bounced`, `failed`, `rejected`,
`complained`) update that status. A Fastmail-style sender-domain/IP block
(`RLR613`, `RLR813`, "blacklisted", Spamhaus DBL) — including deferred 4xx that
carry those signals — is classified as `sender_block`. The pending-verification,
account, and OAuth authorize UIs surface the bounce instead of staying silently
pending, and `POST /account/resend-verification.json` refuses to retry into a
known `sender_block`. The same events write a per-recipient cooldown
(`email_recipient_cooldowns`) so other transactional mail stops hammering that
address, and mark the recipient's MX provider (`email_rejecting_providers`,
keyed by host suffix such as `messagingengine.com`) so holdable kody@ mail
(campaigns, plan-limit nudges) is skipped for that provider until rejections age
out or a successful delivery clears it. Essential mail (verification,
password/sign-in, security, billing) still attempts the send, subject only to
the recipient cooldown. `/pending-verification` polls
`GET /account/email-verification-delivery.json` (session cookie only; no email
query param) for spinner / delivered / failed indicators without exposing other
users' delivery state. The first terminal failure fans
`user.email_verification.failed` to admin-owned packages. When a send stays
`accepted` for an hour with no lifecycle event, the hourly
`email_verification_stall_alert` lane fans `user.email_verification.stalled`.
`/admin/users` and `adminUserList` accept `verification=stalled` for the same
derived set. See
[the admin events guide](../../guides/admin-events.md#useremailverificationfailed-admins)
and
[stalled verification](../../guides/admin-events.md#useremailverificationstalled-admins).

Operators can unblock a stranded signup without a raw D1 write:

- `adminUserVerify` (`mark_verified` or `mint_verify_url`) and the matching
  `/admin/users` actions (`mark_email_verified`, `mint_verify_url`)
- `mark_verified` sets `email_verified_at` (idempotent), clears outstanding
  tokens, and clears the delivery fields
- `mint_verify_url` returns a one-time `/verify-email?token=...` link so the
  operator can send it over a path that is not `kody.codes`
- both paths audit the actor and `target_stable_user_id`
- both actions also run from a job, webhook, or subscription a site admin
  enabled (admin-event auto-rescue), with an extra audit row naming the trigger;
  see
  [Site-admin capabilities from triggered runs](./authorization.md#site-admin-capabilities-from-triggered-runs)

Unverified accounts can still use browser sessions (sign in, manage account,
resend verification), but they must verify before MCP OAuth authorization or
assistant features:

- **Signup**: password signup keeps the authenticated session and lands on
  `/pending-verification` (preserving a safe `redirectTo` such as an OAuth
  authorize URL). Users can resend the verification email and continue once the
  link succeeds; continue returns to `redirectTo` when present, otherwise
  `/onboarding`.
- **Onboarding** (`/onboarding`): verified users only. Unverified HTML requests
  redirect to `/pending-verification`. Loader/API data still exposes
  `emailVerified` and withholds MCP URL/setup until verified as defense in
  depth. `needsOnboarding` means incomplete overall setup (`!emailVerified` or
  no MCP grant). Account keeps an inline verification card for resend/status;
  home and account banners do not show the connect-agent callout while
  unverified.
- **MCP OAuth authorize**: `/oauth/authorize` rejects approval before creating a
  grant/token when the account email is unverified
  (`403 email_verification_required`). The authorize HTML is server-rendered
  with client/scopes from `/oauth/authorize-info` and the signed-in app session
  from the SSR shell, so first paint already shows approve, inline login, or
  verify-email instead of a client `/session` loading state. Approve stays
  disabled until client hydration so a native GET cannot replace the OAuth query
  with the honeypot field; the consent form POSTs to the current pathname+search
  with a hidden `decision=approve` if it is submitted before handlers bind. A
  `/oauth/authorize` request that has no `client_id` but includes `kody_hp` is
  treated as that interrupted resubmit and returns a recoverable "start the
  connection again" message instead of `client_id is required`. The authorize UI
  keeps inline verification/resend controls and the original OAuth query so
  verification in another tab can resume without restarting the host connection.
  Consent binds the grant to one org
  ([0064](../decisions/0064-oauth-org-binding.md)): `?org=<slug>` on the
  authorize URL or `/mcp` resource, a hidden field when the user has exactly one
  org, or a required picker when they have several. Approval stamps `orgId` and
  `personId` on grant props and metadata (`grantBindingFields`). Nothing reads
  `personId` yet; credential resolution will require it for new grants. Grants
  minted before the stamp have only `userId`. There is no feature flag.
- **MCP requests**: `handleMcpRequest` in `packages/worker/src/mcp-auth.ts` is
  the single chokepoint for `/mcp`. After token validation it checks
  `users.email_verified_at` (via `isAccountEmailVerified`) and rejects
  unverified — or unidentifiable — accounts with a
  `403 email_verification_required` JSON response pointing at `/account`. The
  gate fails closed: when verification cannot be established, the request is
  rejected. The request org comes from the grant's `props.orgId` (falling back
  to `props.userId` as the personal org id when the grant has no `orgId`), not
  always the person's implicit personal org.
- **Inbound email**: `handleInboundEmail` in
  `packages/worker/src/email/inbound.ts` rejects routed mail for unverified
  accounts right after username routing (`setReject` plus a bounded `rejected`
  email delivery event); nothing is stored.

Platform suspension (`users.suspended_at`, set by admins from `/admin/users`)
follows the same chokepoint pattern and also fails closed: browser session
resolution treats a suspended session as signed out (`readAuthenticatedAppUser`
/ `loadSessionInfo`), `handleMcpRequest` rejects with a `403 account_suspended`
JSON response after the verification gate, package-app owner resolution refuses
to serve, webhook ingress rejects with `403 account_suspended`, background
identity resolution (`resolveBackgroundMcpUser`) throws `AccountSuspendedError`
for jobs, package invocations, workflows, retrievers, and realtime hooks, and
both email directions reject (inbound with a bounded `account-suspension`
rejection event, outbound with an error). See the "Abuse controls" section of
[`security.md`](../security.md).

- **Email capabilities**: every capability in the MCP `email` domain calls
  `requireVerifiedEmailAccountUser`
  (`packages/worker/src/mcp/capabilities/email/require-verified-user.ts`) as
  defense-in-depth for callers that do not pass through `/mcp` (execute runtime,
  package jobs). Outbound sending additionally re-checks the account inside
  `packages/worker/src/email/outbound.ts` before sending from the
  platform-assigned `{username}@<platform domain>` sender address.

### Password policy

New passwords (signup and password-reset confirmation) must satisfy the
server-side policy in `@kody-internal/shared/password-policy.ts`
(`minPasswordLength`, 8). The server is the trust boundary; the browser hint is
advisory only. Login does **not** re-check length so pre-existing accounts are
never locked out.

## Two-factor authentication and passkeys

Both are opt-in and adapted from the Epic Stack.

**TOTP two-factor** (`packages/worker/src/app/two-factor.ts`):

- The `verifications` table (Epic Stack shape: `type` + `target` with TOTP
  config) stores secrets. An active row with `type = '2fa'` and
  `target = <db user id>` is the "two-factor enabled" flag; a `2fa-verify` row
  holds a pending setup that only activates once the user confirms a generated
  code at `/account/two-factor` (managed by
  `packages/worker/src/app/handlers/account-two-factor.ts`).
- When a 2FA account logs in with a password (or social login), the handler does
  **not** issue `kody_session`. It sets the short-lived signed `kody_verify`
  cookie (`packages/worker/src/app/verify-session.ts`, 10 minutes) and the
  client redirects to `/verify`. `POST /verify/2fa.json`
  (`packages/worker/src/app/handlers/verify.ts`) checks the TOTP code and only
  then issues the real session cookie. Passkey sign-in skips this step: a
  verified WebAuthn assertion already requires possession of the authenticator
  plus user verification (biometric/PIN), so it is treated as MFA-complete.
- Disabling 2FA requires a fresh code. The inline OAuth password form
  (`packages/worker/src/oauth-handlers.ts`) rejects 2FA accounts and directs
  them to establish a browser session first, since that flow has no TOTP step.

**Passkeys / WebAuthn** (`packages/worker/src/app/webauthn.ts`,
`packages/worker/src/app/passkeys.ts`):

- Registration and authentication ceremonies live in
  `packages/worker/src/app/handlers/webauthn.ts` using `@simplewebauthn/server`;
  challenges ride in the short-lived signed `kody_webauthn_challenge` cookie, so
  no server-side ceremony state exists.
- The relying party id/origin derive from the request host. WebAuthn requires a
  registrable domain, so Playwright passkey tests navigate via `localhost`
  rather than `127.0.0.1`.
- Passkeys are stored per user in the `passkeys` table and managed at
  `/account/passkeys`. Passkey sign-in is MFA-complete on its own
  (`userVerification: 'required'`): accounts with TOTP enabled go straight to a
  session and do not visit `/verify`.
- `POST /verify/2fa.json`, `POST /account/two-factor.json`, and
  `POST /webauthn/authentication` share the per-IP auth rate-limit bucket with
  the other credential-accepting endpoints (`packages/worker/src/index.ts`).
- Re-enrolling a new authenticator while two-factor is active is rejected; users
  must disable first (which requires a current code), so a hijacked session
  cannot silently swap the second factor.
- Known limitation: sessions are stateless signed cookies, so enabling
  two-factor (like changing a password) cannot revoke session cookies issued
  earlier; they stay valid until they expire. Starting a new login does clear
  that browser's session cookie while the second factor is pending.

## Account deletion

`POST /account/delete` is implemented by
`packages/worker/src/app/handlers/account-delete.ts`. It soft-deletes through
`softDeleteUserAccount` (`packages/worker/src/orgs/soft-delete.ts`). Hard purge
after the restore window is `hardPurgeSoftDeletedUser`
(`packages/worker/src/orgs/hard-purge.ts`), which calls `deleteUserAccount` in
`packages/worker/src/app/account-deletion.ts`. See
[ADR 0066](../decisions/0066-soft-delete-and-purge.md).

- Requires an active `kody_session` cookie and a JSON body with `confirmation`
  set to `GOODBYE KODY`. Accounts that have a usable password also re-enter
  `password`. Social-login and admin-created accounts with a sentinel hash
  confirm with the phrase alone. Failures emit an audit event with
  `action: 'account_delete'`, `result: 'failure'`.
- The Account settings page opens a modal for this confirmation before posting
  `POST /account/delete`.
- On success the handler clears the session cookie and the account page
  navigates to `/?accountDeleted=1`. The homepage renders "Your Kody account has
  been deleted" from that query, so the confirmation is on the signed-out page
  the user lands on. The edge cache keys anonymous HTML on pathname plus search,
  so this document stays distinct from `/`.
- Successful soft delete best-effort fans `user.deleted` to admin-owned
  packages. Successful password signup, social-login signup, and admin person
  account creation fan `user.created`. See
  [the admin events guide](../../guides/admin-events.md#user-created-and-deleted-admins).
- The handler stamps `deleted_at`, soft-deletes sole-member orgs, and cancels
  Kody Stripe subscriptions. Restore within 30 UTC days is `restoreUserAccount`.
  The JSON body is
  `{ ok, softDeleted: true, restoreWindowDays: 30, userId, deletedAt, deletedOrgIds }`
  plus a `Set-Cookie` that destroys the session. It does not hard-delete rows or
  refund unused time. Prorated refunds run with the later hard purge.
- After the 30-day restore window, the purge lane hard-deletes across the
  surfaces below. While `SOFT_DELETE_PURGE_ENABLED` is not `true`, that lane
  only lists candidates:
  - the user's active package workflow instances, terminated first so no step
    writes after the purge; if any termination fails, deletion stops before
    purging anything and keeps the account fenced so a retry can still find the
    runs (finished instances stay in Cloudflare for their 30-day retention; see
    `accountUserOwnedWorkflowSurfaces`),
  - all `user_id`-scoped D1 tables (children before parents),
  - the shared Vectorize capability index, removing memory, job and
    saved-package entries by id,
  - `BUNDLE_ARTIFACTS_KV` keys captured from `published_bundle_artifacts`, plus
    user-prefixed keys such as the encrypted MCP OAuth refresh-family snapshots,
  - the user's `StorageRunner` Durable Objects via the user-scoped
    `storageRunnerRpc` stub,
  - all OAuth grants for the user (and the provider clients the user minted) via
    the bound OAuth provider,
  - the user row itself last so a partial failure can be retried.
- `env.OAUTH_PROVIDER` is injected by `@cloudflare/workers-oauth-provider` only
  inside its own `fetch` wrapper, so the soft-delete POST does not use it, and
  it is also absent for the hourly unverified-account purge
  (`JobsHost.runScheduledLane` RPC on origin) or for
  `adminUnverifiedAccountPurgeRun` when served from the sessionful `MCP` Durable
  Object on kody-platform. Those paths call `resolveOAuthHelpers`
  (`packages/worker/src/oauth-helpers.ts`), which returns `env.OAUTH_PROVIDER`
  when present and otherwise builds the same `OAuthHelpersImpl` through the
  library's `getOAuthApi(options, env)` over `OAUTH_KV`. The non-handler
  provider options (endpoints, scopes, TTLs, CIMD, `onError`) live in
  `packages/worker/src/oauth-provider-options.ts` and are spread into both the
  origin `OAuthProvider` and the fallback, so storage semantics cannot drift;
  the fallback supplies inert 404 handlers because the helpers API never routes
  a request. The fallback loads the library from the pre-bundled
  `oauth-provider.mjs` additional module
  (`tools/build-worker-bundler-modules.ts`, `find_additional_modules`) because
  wrangler inlines plain dynamic imports into the main module; the startup
  bundle check forbids the provider package in the platform/runtime entries so
  it stays off their startup path. Hard purge only reports "OAuth grants were
  not revoked" when both `OAUTH_PROVIDER` and `OAUTH_KV` are missing. Account
  export's `oauth_grants` section (`packages/worker/src/account/export.ts`) uses
  the same reader for `listUserGrants`, so `accountExportManifest` /
  `accountExportSection` served from the platform `MCP` Durable Object include
  grant metadata too.
- After the user row is gone, origin clears the UserMeter deletion tombstone
  `purge()` restored so the purged object keeps no state. A later signup with
  the same email or username gets a new random `stable_user_id`, so it never
  shares the deleted account's Durable Objects, storage prefixes, or secrets.
- `deleteUserAccount` (the hard purge) returns
  `{ deletedRowCounts, deletedKvKeys, revokedOAuthGrants, clearedDurableObjects, deletedVectors, warnings }`.
  That payload is not the `POST /account/delete` response.

Related handlers:

- `GET /login` and `GET /signup`:
  `packages/worker/src/app/handlers/auth-page.ts`
- `POST /logout`: `packages/worker/src/app/handlers/logout.ts`
- `POST /session`: `packages/worker/src/app/handlers/session.ts` for session
  status checks
- `GET /account`: `packages/worker/src/app/handlers/account.ts` (redirects to
  login if missing session)

### Client session refresh behavior

The app shell (`packages/worker/client/app.tsx`) refreshes session state after
initial load and on client-side navigation events. Navigation-triggered
refreshes are throttled (30s) to avoid a `/session` round trip on every SPA
navigation, but the throttle never applies to refreshes that follow a mutation:
the client router (`packages/worker/client/client-router.tsx`) emits a
`mutation` event after every form POST it submits (exposed as
`listenToRouterMutations`), and the shell marks its session state stale so the
follow-up redirect navigation refreshes it regardless of the throttle —
auth-changing POSTs like `/logout` update the top nav immediately. If an
in-flight refresh is aborted, the client keeps the last known ready session
instead of overwriting it with `null`. This prevents transient logged-out UI
during concurrent re-renders.

## Password reset

Password reset handlers are in
`packages/worker/src/app/handlers/password-reset.ts`.

- `POST /password-reset` creates a one-time token and stores only its hash
- the response is uniform for registered and unregistered addresses in both body
  and latency: after the user lookup the token writes and the email send are
  deferred past the response (`packages/worker/src/deferred-work.ts`, kept alive
  by `ctx.waitUntil`), so response time cannot be used to enumerate accounts
- `POST /password-reset/confirm` verifies token hash and expiry, updates the
  password, revokes every MCP OAuth grant for that user, stamps
  `users.password_changed_at`, then revokes again so a grant created in that
  window cannot survive. It also disables two-factor authentication, deletes
  passkeys and `oauth_connections`, and sends a confirmation email listing those
  cleared sign-in methods
- Session cookies and package-app sessions whose `issuedAt` is missing or at or
  before `password_changed_at` fail closed; `/mcp` rejects access tokens whose
  `createdAt` is at or before that timestamp (`invalid_token`)
- reset tokens expire after 1 hour
- when configured, email delivery is done via Cloudflare Email API
- when required Cloudflare Email API credentials are unset, the helper logs a
  redacted diagnostic without the email body or token URL to prevent token
  leakage in logs
- public reset forms include a honeypot whose field name is not an HTML
  autocomplete token (`kody_hp` in
  `packages/worker/universal/public-form-protection.ts`), so password managers
  do not treat it as a login website field

## Password change

Signed-in password change is `POST /account/password.json`
(`packages/worker/src/app/handlers/account-password.ts`), exposed on `/account`.

- Requires the current password when the account has a usable password hash
- Accounts that only sign in with a connected provider or passkey can set a
  first password without a current password
- New passwords go through `getPasswordPolicyError`
- Shares `applyPasswordChange` with reset confirmation: revoke MCP grants, stamp
  `users.password_changed_at`, revoke again, delete outstanding reset tokens.
  Unlike reset confirmation, this path does not clear two-factor, passkeys, or
  linked providers
- Re-issues the current session cookie with `issuedAt` strictly after
  `password_changed_at` so this browser stays signed in
- Joins the shared auth rate-limit bucket and a per-user password-change budget

## Package app origin handoff

Hosted package apps run on their own registrable domain in production
(`PACKAGE_APP_BASE_URL`) so author-supplied code is cross-site from the app
origin — see
[Hosted package app origin isolation](../security.md#hosted-package-app-origin-isolation)
for why. Production serves each owner's apps on a per-user subdomain of that
domain (`https://{username}.kody.run/packages/{kodyId}/...`); the apex only
redirects. That means `kody_session` never reaches them, so the package-app
subdomain needs its own, deliberately smaller credential.

**Handoff token** (`packages/worker/src/app/package-app-handoff.ts`). When a
signed-in owner requests `/@{username}/packages/{kodyId}/...` on the app origin,
the app origin mints `<base64url payload>.<HMAC-SHA256>`:

- signed with `COOKIE_SECRET` over a purpose-labelled message
  (`kody-package-app-handoff:v2`), so it is not interchangeable with any other
  signed value
- payload binds `{ stableUserId, username, kodyId, exp, jti }`; the package-app
  subdomain rejects a token whose `username`/`kodyId` do not match the requested
  path
- 60 second lifetime
- single use: `jti` is burned in `BUNDLE_ARTIFACTS_KV` for 60 seconds on first
  use. The burn happens **after** the path binding is checked, so a token
  presented on the wrong package path is refused without being consumed — a
  mistyped URL must not cost the owner a handoff they still hold. Replay
  protection is best effort (KV is eventually consistent) and is skipped when
  the binding is missing; signature, expiry, and the path binding always fail
  closed.

It travels in the `__kody_handoff` query parameter of a cross-origin redirect to
the owner's package-app subdomain, which is why it is deliberately this weak. A
token in a URL is exposed to browser history, referrers, and anything that logs
URLs; the subdomain redirects straight to the same URL without it, which reduces
that exposure but cannot eliminate it. The 60-second expiry and the single-use
burn are what bound the damage when a token does leak. A request that still
carries the parameter is rewritten without it before package code sees it.

Mint and consume must share `COOKIE_SECRET`. In production the app-origin mint
(`/@{username}/packages/...`) is forwarded to `kody-runtime`, and the subdomain
exchange is served by that same script's zone routes. Production CI therefore
syncs `COOKIE_SECRET` onto the unsuffixed `kody-runtime` script (`--env ""` plus
`--name`); `wrangler secret bulk --env production --name kody-runtime` still
writes `kody-runtime-production`, which the runtime deploy does not serve. If a
leftover main-worker route still receives `{username}.kody.run`, the main Worker
must forward it too (`isRuntimeWorkerOwnedRequest` matches every package-app
host, not only the apex). A `COOKIE_SECRET` mismatch, or a missing secret
swallowed as "invalid token", leaves the visitor on the 403 page with
`__kody_handoff` still in the URL and no `Set-Cookie`. Missing `COOKIE_SECRET`
on consume fails closed with 500; signature / expiry / path / replay rejects log
a reason without the token and set `X-Kody-Handoff: rejected`.

**Package-app session cookie**
(`packages/worker/src/app/package-app-session.ts`). Exchanging a valid token on
the owner's subdomain sets a **per-app** `__Host-kody_pkg_session_<hash>` cookie
on secure requests (plain `kody_pkg_session_<hash>` on insecure local HTTP
only). The hash is `sha256(leaf)[0:12]`, matching package-app access tickets.
`__Host-` rules still require `Path=/` and forbid `Domain`, so path scoping is
unavailable; the cookie _name_ carries the app scope so logout of one leaf on a
shared host does not clear sibling apps.

- `httpOnly: true`, `sameSite: 'Lax'`, `path: '/'`, `secure` per request
- max age is the **remaining** lifetime of the `kody_session` that minted the
  handoff (7 days, or 30 days with remember-me), snapshotted into the token as
  `sessExp` and into the cookie as `expiresAt`. Browser `Max-Age` and a
  server-side `expiresAt` check in `readPackageAppSession` both use that
  instant, so the package-app cookie cannot outlive the parent session.
  Remember-me renewal on the app origin does not extend an already-issued
  package-app cookie; a later handoff mints a new snapshot. Tokens without
  `sessExp`, and cookies without `expiresAt`, use a 12 hour lifetime from
  mint/`issuedAt`
- signed with a **derived** secret,
  `sha256Base64Url('kody-package-app-session:v2:' + COOKIE_SECRET)`, so a value
  signed for this cookie can never verify as a `kody_session`
- payload is `{ v: 3, stableUserId, pkgUsername, app, issuedAt, expiresAt? }` —
  a shape the app session schema rejects, so the two cannot be confused even by
  name substitution. Readers also accept legacy host-wide `v: 2` cookies (no
  `app` field / unhashed name) until the next login/handoff or logout clears
  them. New cookies always set `expiresAt`; readers treat a missing field as the
  12 hour mint/`issuedAt` fallback above.
- the `__Host-` prefix on secure requests forbids a `Domain` attribute, so
  sibling subdomains cannot plant a shadow cookie under this name
- sibling subdomains are still same-site (until the Public Suffix List entry),
  so mutating requests additionally require any `Origin` header to match the
  subdomain itself — see the same-site paragraph in
  [security.md](../security.md#hosted-package-app-origin-isolation)

It authorizes hosted package-app serving for one account on one package leaf on
that account's subdomain (or verified custom domain) and nothing else: the app
origin has no code path that reads it, and the package-app domain has no
first-party routes. Every request re-resolves the account from D1
(`resolvePackageAppOwnerByStableUserId`) and fails closed for unknown, deleting,
or suspended accounts, for sessions issued at or before
`users.password_changed_at` — the same rules browser sessions follow — and when
the session account's username does not match the subdomain label and requested
package path. Confirmed local, preview, and test runtimes with
`PACKAGE_APP_BASE_URL` unset never mint either credential; they serve package
apps inline behind `kody_session`. Production requires a separate registrable
package-app origin and returns `500` instead of falling back inline when that
configuration is missing or unsafe.

## Account secret reveal

The account secrets API (`packages/worker/src/app/handlers/account-secrets.ts`)
returns a decrypted secret value to the **owner** only, and only for the
selected secret:

- `GET /account/secrets.json?selected=<secretId>` resolves the value into the
  `selectedSecret.value` field of the JSON payload
- Requires an active `kody_session` cookie; the value is scoped to the
  authenticated user's `mcpUser.userId`, so a session can only ever read its own
  secrets
- All responses set `Cache-Control: no-store`
- There is **no** separate `/@<slug>/-/secrets/reveal` endpoint and **no**
  password reauthentication step — revealing a secret is inside the owner's own
  trust boundary (same-origin, session-authenticated)

This is an intentional design decision, not an oversight. The exfiltration
concern (XSS or a stolen session reading the owner's secrets) is mitigated by:

- the strict first-party `Content-Security-Policy` (`script-src 'self'`, no
  `'unsafe-inline'`) plus `HttpOnly` + `SameSite=Lax` session cookies (see
  `docs/contributing/security.md`), which make script-injection theft hard
- decryption at rest and per-user scoping on every read

Residual risk: a stolen session cookie can read the owning user's own secrets
until it expires (sessions are stateless — see the "Accepted residual risks"
section of `docs/contributing/security.md`). If a future change needs a stronger
control, the recommended approach is a password-reauthenticated reveal endpoint
combined with server-side session invalidation. Do not silently reintroduce
plaintext reveal without also considering that hardening.

## Social login (GitHub / Google / X / Discord)

Kody can act as an OAuth 2.0 client of GitHub, Google, X, and Discord for
browser sign-in. Provider identities live in the `oauth_connections` table;
handlers live in `packages/worker/src/app/handlers/auth-provider.ts` with the
provider definitions in `packages/worker/src/app/oauth-providers.ts`. Discord
connections also best-effort join the official Kody Discord (`guilds.join` plus
the operator bot) and assign or remove configured guild roles
(`packages/worker/src/discord/guild-role.ts`) without persisting the login
token. The member role is assigned on connect; Standard and Pro roles follow
`orgs.stripe_plan`.

- `POST /auth/:provider` starts the flow (CSRF state + PKCE verifier in the
  signed `kody_oauth_login` cookie); `GET /auth/:provider/callback` completes it
  and issues the normal `kody_session` cookie. The first-party UI fetches the
  start endpoint with `Accept: application/json` and navigates to the returned
  authorize URL itself, because the CSP locks `form-action` and `connect-src` to
  `'self'`
- Existing connections sign in directly; the two-factor gate applies exactly as
  for password logins (passkey sign-in skips TOTP)
- A signed-in user whose live `email_verified_at` is set hitting the callback
  links the provider identity to their account, managed from the `/account`
  "Connected accounts" card backed by `/account/connections.json` (disconnect is
  refused when the connection is the only sign-in method). An unverified
  signed-in session is refused (`email-unverified`) so a password squat cannot
  attach a provider and skip the unverified-account purge. `/discord` is the
  public **Connect Discord** page (one action joins the official server and
  links the account)
- A provider-verified email matching an existing **verified** account auto-links
  and signs in. A match against an **unverified** account reclaims that row
  first (unusable password sentinel, `password_changed_at` lockout, TOTP /
  passkeys / other `oauth_connections` / reset tokens cleared) so a squatted
  password signup cannot keep access after the real owner signs in with the
  provider; otherwise a new account is created. Signup is open and new accounts
  start on the `free` plan
- Buttons only render for providers whose client id/secret env vars are set;
  `MOCK_`-prefixed client ids activate an in-worker mock flow on non-production
  runtimes for dev and E2E tests

Setup and operational details: `docs/contributing/social-login.md`.

## OAuth for MCP

OAuth endpoints are implemented in `packages/worker/src/oauth-handlers.ts` and
routed from `packages/worker/src/index.ts`.

- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token` (via provider; also RFC 7009 revocation)
- Client registration: `/oauth/register` (via provider), plus Client ID Metadata
  Documents (`clientIdMetadataDocumentEnabled` in
  `packages/worker/src/origin-handler.ts`): a client may present an HTTPS URL as
  its `client_id` with no registration step. Signed-in users can also mint a
  confidential pre-registered client from `/account/mcp-oauth-clients` (Account
  → Agents → Advanced). That page is user-minted clients, not inbound host
  grants. Account → Agents (`/@<slug>/-/agents`) lists inbound grants from
  `listUserGrants` (paged) joined with `lookupClient` for a best-effort label,
  authorized time, and revoke. The account UI groups those unique `clientId`s by
  display name, shows a public icon when the host kind already has an SVG, and
  sorts last-used newest-first, then connected time. Timestamps are grant
  `createdAt` (connected time) plus last-used from UserMeter
  `inbound_mcp_connection_last_used` (successful `/mcp` bearer validation, keyed
  by inbound OAuth `clientId`, 5-minute Durable Object debounce, `waitUntil` so
  it is not on the awaited hot path). Unknown last-used renders as "never" and
  is the revoke signal; Connected remains grant `createdAt`. Revoke deletes the
  last-used row with the grant. Onboarding Step 3 completion is two known agent
  ecosystems, not raw grant count, not unique `clientId`s, and not
  `users.mcp_client_name`. `user_mcp_oauth_clients` stores the account-owned
  metadata. The provider stores the secret hash in `OAUTH_KV` via
  `env.OAUTH_PROVIDER.createClient()`. List and revoke are scoped to the owning
  `user_id`. The plaintext secret is shown once and never written to D1. MCP
  `2026-07-28` deprecates RFC 7591 dynamic registration in favor of CIMD, so
  both stay enabled: clients without a pre-registered credential that do not use
  CIMD register via `/oauth/register`. Failed CIMD fetches throw
  `CimdFetchError`: authorize maps that to an unknown-client page, and the token
  endpoint still returns generic `invalid_client`. Any DCR retry after that is
  the client's own recovery, not a server-side fallback. CIMD metadata fetches
  rely on the `global_fetch_strictly_public` compatibility flag in
  `packages/worker/wrangler.jsonc` for SSRF safety; the provider only advertises
  `client_id_metadata_document_supported` when both are set. ChatGPT CIMD
  documents prefer `private_key_jwt` while also offering `none`; the provider
  negotiates the mutually supported public method `none` and requires PKCE.
  `onError.internal` category `client-id-metadata-document` is reported to
  Sentry. Authorization-server metadata advertises `S256` PKCE only.
- Kody-as-client (user-added remote MCP servers) hosts its own CIMD at
  `/oauth/client-metadata.json`. The document is origin-exact: `client_id`
  matches the fetch URL, and `redirect_uris` lists
  `{origin}/account/mcp-servers/oauth/callback`. The MCP client OAuth provider
  sets `clientMetadataUrl` to the canonical HTTPS document URL so the SDK
  prefers CIMD and falls back to DCR. Local `http` origins omit
  `clientMetadataUrl`.
- The official CLI (`@kodycodes/cli`) hosts its CIMD at
  `/oauth/cli-client-metadata.json`. The document is origin-exact: `client_id`
  matches the fetch URL, and `redirect_uris` lists the fixed loopback
  `http://127.0.0.1:43742/callback` so the CLI can use SEP-991 instead of
  deprecated DCR.
- Supported scopes: `openid`, `profile`, `email` (additive; `openid` enables ID
  tokens and the UserInfo endpoint). These are OIDC identity claims, not a
  permission menu. MCP access is one grant: a valid token for this origin's
  `/mcp` audience receives the full assistant. `/oauth/authorize` describes that
  grant in plain language and keeps the OIDC names in a technical disclosure.
  See [0049](../decisions/0049-no-mcp-capability-oauth-scopes.md).
- Kody's MCP authorization server is an **OAuth 2.1 + OpenID Connect
  Authorization Code** provider with CIMD and RFC 9728 resource metadata. Issuer
  is the app origin (`getAppBaseUrl`). `sub` identifies the connection: personal
  (and personal-org) grants use the account `stable_user_id`; organization
  grants use `org:<orgId>:user:<userId>` so one person can connect both a
  personal and an org account to the same OIDC client. Existing grants without
  `metadata.orgId` or `props.orgId` keep the `userId` subject on refresh and
  code exchange; reauthorization is required for an organization-specific
  subject. ID tokens are RS256 JWTs signed with `OIDC_SIGNING_PRIVATE_KEY_PEM`
  (`kid` = `OIDC_SIGNING_KEY_ID`). Discovery:
  `/.well-known/openid-configuration`; JWKS: `/.well-known/jwks.json`; UserInfo:
  `/oauth/userinfo` (Bearer access token; fail-closed when email is unverified).
  RP-Initiated Logout: `/oauth/logout`. RFC 7009 revocation is the token
  endpoint (`/oauth/token`); both `/.well-known/openid-configuration` and
  `/.well-known/oauth-authorization-server` advertise that URL as
  `revocation_endpoint`. OpenID Connect discovery also lists
  `revocation_endpoint_auth_methods_supported` matching
  `token_endpoint_auth_methods_supported` (`none`, `client_secret_basic`,
  `client_secret_post`) so public clients are not left with RFC 8414's omitted
  default of `client_secret_basic` only. Authorization-server metadata from
  `@cloudflare/workers-oauth-provider` omits that auth-methods array. Token
  responses from `/oauth/token` gain an `id_token` when the granted scope
  includes `openid` (authorization_code and refresh_token grants; refresh omits
  `nonce`). The provider handles the token path internally and does not inject
  `env.OAUTH_PROVIDER` there (or on UserInfo/logout, which run before
  `oauthProvider.fetch`), so those OIDC helpers come from `resolveOAuthHelpers`
  over `OAUTH_KV`. Implicit and Hybrid response types are not advertised or
  accepted. Authorization responses that send the client back to `redirect_uri`
  (successful `code` redirects and OAuth/OIDC error redirects) include RFC 9207
  `iss` equal to the discovery issuer (`getAppBaseUrl`). Authorization-server
  metadata advertises `authorization_response_iss_parameter_supported: true`.
  `@cloudflare/workers-oauth-provider` adds `iss` on success only when
  `AuthRequest.issuer` is set; Kody assigns that field from `getAppBaseUrl` and
  stamps `iss` on every outbound client redirect so a missing provider field
  cannot omit it. Local HTML or JSON authorize errors that do not redirect to
  the client do not include `iss`. Kody is not OpenID Certified. `/api/me`
  remains the OAuth-protected JSON helper for grant props; it is not the OIDC
  UserInfo endpoint.
- On `/oauth/authorize`, unauthenticated users can log in with the same methods
  as `/login` (password, social providers including GitHub, and passkey) inline,
  or via top-nav / “full sign-in page” links. Those flows preserve the full
  authorize URL in `redirectTo` so successful login returns to the original
  OAuth request (client_id, redirect_uri, PKCE, state, scope, org). After auth,
  `prompt=login` is stripped from that resume target so the new session is not
  treated as signed-out on the consent screen. Password signup lands on
  `/pending-verification` with that safe `redirectTo` preserved for
  continue-after-verify. The authorize tab itself should stay open when the
  email link is opened elsewhere, so the original OAuth query remains resumable.
  Signed-in vs signed-out chrome on that page comes from the SSR-embedded app
  session; the route does not wait on a separate browser `/session` fetch before
  rendering approve or login. Social buttons use the same SSR-embedded provider
  list as `/login`, so a full-document load does not wait on
  `/auth/providers.json`. The approve control stays inert until hydration so the
  visible button cannot submit a GET that drops `client_id`.
- Approval is rejected before `completeAuthorization` when the account email is
  unverified, so no grant/token is created until verification succeeds.

Token lifetimes are set on the `OAuthProvider` in
`packages/worker/src/oauth-provider-options.ts`:

- Access tokens keep the provider default of 1 hour
- Refresh tokens are issued with no expiry (`refreshTokenTTL: undefined`). The
  provider default is 30 days; omitting the option keeps that default, so the
  explicit `undefined` is required
- Dynamically registered clients are stored with no KV expiry
  (`clientRegistrationTTL: undefined`). The provider default is 90 days. Clients
  created through `OAuthHelpers.createClient()` are unexpiring. A DCR client
  record that already has a KV TTL still expires at that instant unless the host
  re-registers

The provider still rotates refresh tokens on use and keeps only the current hash
plus the immediately previous hash on the grant. MCP hosts on one machine often
share one stored client and each keep their own copy of the last refresh token
they saw, so a second host presenting the previous token must not mint a third
token and invalidate the sibling. `packages/worker/src/oauth-refresh-family.ts`
intercepts `POST /oauth/token` refresh grants:

- Reuse of the current family's previous refresh token returns the stored
  current access and refresh tokens. The grant does not rotate again, even when
  that access token is near expiry — only presenting the current refresh token
  rotates. The sibling can then refresh with the current token.
- A one-hour replay record keyed by the consumed refresh-token hash returns that
  same current family when the hash still matches the grant's current token,
  even when the stored access token is near expiry. After the next rotation the
  old replay no longer matches and the consumed token is `invalid_grant`. The
  one-hour TTL is maximum retention, not guaranteed acceptance.
- Tokens that are neither current, previous, nor a still-matching replay do not
  mint. Stolen refresh tokens therefore cannot walk the family forever; they
  work only while they remain the current or previous token, or while a replay
  still matches the grant's current hash.
- Previous-token reuse and matching replay skip the isolate lock so a
  current-token rotation cannot turn a still-valid previous token into
  `invalid_grant`. Provider rotation for one `userId`/`grantId` pair is
  serialized in the handling isolate. After a rotation the isolate remembers the
  new family in memory so a waiter can reuse it even when Workers KV still
  serves the pre-rotation miss. Isolate memory keeps only the current replay
  entry and is dropped when the handling isolate revokes that grant. Revoke
  marks the grant forgotten immediately so lock-skipping reuse cannot serve
  cached tokens, then waits for any in-flight persist so a later remember cannot
  rewrite deleted-grant tokens. That is isolate-local, not a cross-isolate
  Durable Object lock. Two current-token refreshes that land on different
  isolates can still race the provider before a snapshot is visible. A revoke
  that lands on another isolate can leave residual memory until that isolate
  exits.
- Encrypted snapshots live in `BUNDLE_ARTIFACTS_KV` under
  `derived-cache:v1:mcp-oauth-refresh-family:` / `-replay:` with KV TTLs of two
  hours and one hour. Account deletion prefix-deletes the user's keys; the TTL
  covers any key written by a refresh that races deletion. Snapshot writes are
  best-effort: a KV or encrypt failure does not replace the provider's minted
  response.

`/mcp` is protected by `packages/worker/src/mcp-auth.ts`:

- Requires `Authorization: Bearer <token>`
- Token is validated via OAuth provider helpers (`unwrapToken`)
- Audience must match the app origin or `<origin>/mcp`
- Token OIDC scopes are not checked for MCP capability access. Audience,
  identity, email verification, suspension, and password-change gates apply; the
  token is then the full assistant
- Requests without a Bearer token return `401` with `WWW-Authenticate` carrying
  RFC 9728 `resource_metadata` (and scopes). RFC 6750 omits `error` when
  credentials are absent
- A present but rejected Bearer token returns `401` with RFC 6750
  `error="invalid_token"` plus `error_description` and the same
  `resource_metadata`, so hosts that refresh on that challenge can do so without
  starting a new browser login
- The account email must be verified; unverified accounts receive a
  `403 email_verification_required` response (see the email verification section
  above)

## What to read when changing auth

- `packages/worker/src/index.ts` for route order and integration points
- `packages/worker/src/oauth-handlers.ts` for OAuth authorization logic
- `packages/worker/src/oauth-refresh-family.ts` for refresh-token family reuse
  on `/oauth/token`
- `packages/worker/src/mcp-auth.ts` for MCP token enforcement
- `packages/worker/src/app/auth-session.ts` for cookie format/signing
- `packages/worker/src/app/handlers/auth.ts` for app login/signup flow
- `packages/worker/src/identity/admin-user-creation.ts` for admin-created
  account setup links
- `packages/worker/src/app/email-verification.ts`,
  `packages/worker/src/app/handlers/verify-email.ts`, and
  `packages/worker/src/app/handlers/account-resend-verification.ts` for
  verification tokens and resends
- `packages/worker/src/email/destinations.ts`,
  `packages/worker/src/email/destination-verification.ts`, and
  `packages/worker/src/app/handlers/account-email-destinations.ts` for extra
  email destinations
- `packages/worker/src/app/handlers/account-secrets.ts` for owner-scoped secret
  reveal
- `packages/worker/src/app/deployment-env.ts` for non-production runtime
  detection (developer-only routes, mock OAuth)
