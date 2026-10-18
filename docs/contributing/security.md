# Security

Security-relevant patterns in the Worker, and the reasoning behind them. This
doc is the authoritative record of what is protected, what is intentionally out
of scope, and the invariants future changes must not regress. See the 2026-05-01
and 2026-07-01 internal security audits for the underlying findings, and
[the 2026-09-16 codebase audit](../audits/2026-09-16-codebase-audit.md) for a
later cross-cutting review.

Kody is a multi-worker Cloudflare app: a Remix 3 browser UI and OAuth-protected
MCP HTTP on origin, platform Durable Objects on `kody-platform`, package apps on
`kody-runtime`, and cron on `kody-jobs`. It is multi-user, so the overarching
invariant is that **every read/write path is scoped by `userId`** (see
[`AGENTS.md`](../../AGENTS.md)). Cross-user data sharing is a bug, not a
feature. See [architecture](architecture/index.md#production-worker-fleet).

## Invariants for future agents (do not regress)

Read this list before touching auth, routing, response construction, or the
package-app surfaces:

1. **First-party HTML keeps its security headers.** All trusted account/auth
   pages must go through `render()` (`packages/worker/src/app/render.ts`), which
   applies `packages/worker/src/app/security-headers.ts`. Never add
   `'unsafe-inline'` to the CSP `script-src`. The scroll-restoration restore
   script is allowed only by its sha256 hash, not by relaxing `script-src`.
2. **Untrusted surfaces stay off the strict CSP.** Hosted package apps
   (`https://{username}.<package-app host>/packages/*` in production, or
   `/@username/packages/*` when served inline) execute author-supplied HTML/JS
   and intentionally do not use the first-party CSP. Do not "unify" the two.
   Because they have no CSP backstop, their isolation comes from the origin they
   run on and the credentials they never receive — see invariant 9.
3. **Developer-only routes fail closed.** Anything that runs attacker-authored
   content or aids debugging must be gated behind `isNonProductionRuntime`
   (`packages/worker/src/app/deployment-env.ts`) so it is unreachable in
   production.
4. **Credential endpoints are rate limited.** Any new endpoint that accepts a
   password, token, or reset code must join the shared auth rate-limit bucket in
   `packages/worker/src/origin-handler.ts` (`rateLimitedAuthPaths`).
5. **New passwords go through the shared policy.** Use `getPasswordPolicyError`
   from `@kody-internal/shared/password-policy.ts` wherever a password is set.
6. **OAuth PKCE stays S256-only.** Keep the `getPkceValidationError` check in
   `oauth-handlers.ts` (reject `code_challenge_method` other than S256 when a
   challenge is present). `@cloudflare/workers-oauth-provider` is S256-only (no
   `allowPlainPKCE`); see the OAuth section below.
7. **Every data path is `userId`-scoped.** New D1 queries, Durable Object names,
   and Vectorize filters must include `userId`. Prefer parameterized SQL
   (`.prepare(...).bind(...)`); never interpolate user input into SQL.
8. **Untrusted markdown renders through the safe renderer only.** Community
   READMEs (and any future third-party-authored markdown shown on first-party
   pages) must go through `packages/worker/start/components/markdown-view.tsx`,
   which builds JSX from an allowlist of `marked` lexer tokens: raw HTML renders
   as escaped text (first-party guides may additionally emit allowlisted
   `<details>`/`<summary>` and GitHub-style `> [!TIP]` callouts; untrusted
   markdown never does), and links are restricted to absolute
   `http:`/`https:`/`mailto:` URLs with `/@...` user-scope paths and
   `/packages/...` package-app mount paths refused on any host so a README can
   never point viewers at hosted package endpoints. `<img>` is emitted only for
   in-repo relative image paths rewritten to that package's first-party
   `/assets/` route (published or pinned package bytes, sniffed type,
   size-capped) and only when the viewed markdown is that same commit. Remote
   and other author-chosen URLs stay links. Never render third-party markdown
   via an HTML string, `innerHTML`, or a markdown-to-HTML renderer.
9. **Package code never receives first-party credentials, and never executes on
   the app origin in production.** Every request handed to package code goes
   through `createPackageCodeRequest`
   (`packages/worker/src/app/handlers/package-app.ts`), which strips `Cookie`,
   `Authorization`, `Proxy-Authorization`, and every `X-Kody-*` header — for the
   forwarded HTTP request _and_ the realtime connect upgrade, because the
   realtime `connect` hook is handed the request headers too. Production also
   sets `PACKAGE_APP_BASE_URL` so package apps run on their own registrable
   domain, cross-site from the app origin. Do not add a first-party route to the
   package-app origin, and do not reintroduce cookie forwarding "just for
   convenience". See
   [Hosted package app origin isolation](#hosted-package-app-origin-isolation).
10. **CSRF protection is `SameSite=Lax` + JSON content types, not tokens.**
    Every mutating first-party endpoint must keep requiring a JSON
    `Content-Type` (which cross-site form posts cannot send) and the
    `kody_session` cookie must stay `SameSite=Lax`. Do not add a mutating
    endpoint that accepts `application/x-www-form-urlencoded` or
    `multipart/form-data` from the browser, and do not relax the cookie to
    `SameSite=None`, without adding CSRF tokens at the same time.
11. **Email change requires a verified current address.**
    `POST /account/email-change.json` refuses to start a change when
    `users.email_verified_at` is null (403, audit reason `email_unverified`). A
    former-email claim collision at password or social-login signup is a
    controlled 409 with audit reason `former_email_claimed` (copy tells the
    person to sign in with the email that account uses now, or release the
    address from Account settings — never leaking the current email). The owner
    re-verifies the former address (`POST /account/email-claim-release.json`
    plus `/verify-email-claim-release`) to drop the claim; that path is rate
    limited. New accounts get random `stable_user_id` values. Only `users.email`
    and active `user_email_claims` rows reserve an address; a legacy email-hash
    `stable_user_id` reserves nothing and is never recomputed from an email.
12. **Unverified accounts are reclaimed on a provider-verified social match.**
    When a social login profile presents a verified email that matches
    `users.email` and `email_verified_at` is null, treat the row as a possible
    squat before linking: rotate `password_hash` to an unusable sentinel, stamp
    `password_changed_at` (browser sessions and MCP bearers fail closed), revoke
    MCP grants, delete TOTP rows, passkeys, other `oauth_connections`, and
    outstanding `password_resets`, then link the provider and mark the account
    verified. An already-verified match only links and signs in.
13. **Unverified person accounts older than seven days are purged.** The hourly
    `unverified_account_purge` lane deletes `person` accounts whose
    `email_verified_at` is still null, `created_at` is older than seven days,
    and no `oauth_connections` row exists. The `oauth_connections` exemption is
    sound only because signed-in provider linking refuses a live
    `email_verified_at IS NULL` row (the insert is fenced on
    `email_verified_at IS NOT NULL AND deleting_at IS NULL`) and unauthenticated
    social sign-in always verifies. Each candidate is claimed with an atomic
    `UPDATE` that restamps `deleting_at` only while that eligibility still
    holds. Once claimed, email verification and social-login reclaim refuse the
    fenced row. A claim-created fence is released only on pre-cleanup failures
    (active writers or inventory); a partial-cleanup failure leaves the fence
    for retry. Never-attempted rows are processed before retries. Deletion uses
    the inventory-driven account-deletion path. Each purge writes an
    `unverified_account_purged` audit row; each failed deletion writes an
    `unverified_account_purge_failed` audit row (hashed email, reason
    `<ErrorClassName>: <first inventory/cleanup warning or message>` with email
    addresses redacted and bounded to 200 characters) and a Sentry event tagged
    `scheduled.lane`, so a lane that fails every hour is visible without Workers
    Logs. Both are best-effort: an `AUDIT_DB` or Sentry outage is logged and
    skipped, not fatal. Operators run one pass on demand with the admin-only
    `adminUnverifiedAccountPurgeRun` MCP capability (`dryRun` previews the next
    claim page; results carry stable user ids, never emails or usernames).
    Password signups are the only unverified path; social-login accounts are
    verified at creation. Signed-in linking of a provider to a password account
    also requires that live verified email.
14. **Password-reset confirmation clears second factors and linked providers.**
    `POST /password-reset/confirm` disables TOTP, deletes passkeys and
    `oauth_connections`, and tells the owner in the confirmation email.
    Signed-in `POST /account/password.json` leaves those factors in place.
15. **User-secret trust grants are never applied by MCP or package runtimes.**
    `secretLock` returns a website approval URL and does not write
    `allowed_packages`. Community fork adoption widens implicit user-secret
    read/use for a fork, so only the signed-in account session writes it
    (`adopt-community-fork` on `POST /account/packages.json`, from the package
    settings page). `communityForkAdopt` is read-only and returns that link.
    Interactive `execute` runs imported package code with the agent's caller
    context, so no `kody.*` capability may adopt: an unadopted fork would adopt
    itself. Package apps, jobs, webhooks, and other package runtimes cannot
    adopt or grant themselves secrets.

## First-party HTTP security headers

`render()` attaches the header set in
`packages/worker/src/app/security-headers.ts` to every trusted HTML response
(login, signup, account pages, the OAuth consent screen, and the SPA shell):

- `Content-Security-Policy` with `script-src 'self' https://cdn.usefathom.com`
  (no `'unsafe-inline'`; the Fathom Analytics tracker is the only allowed
  external script; its image pageview beacon is allowed in `img-src` and its
  `sendBeacon` duration/event pings are allowed in `connect-src`; the
  scroll-restoration restore script is an inline classic script allowed only by
  its sha256 hash), `img-src` also allowlists `https://static.scarf.sh` for the
  Scarf page pixel on public marketing and docs, `frame-ancestors 'none'`,
  `base-uri 'self'`, `object-src 'none'`, `form-action 'self'`,
  `worker-src 'self' blob:` (for Sentry Session Replay), and `connect-src`
  limited to `'self'` plus the Fathom, Cloudflare Web Analytics, and Turnstile
  beacon hosts. The client bundle loads as an external module. `style-src`
  allows `'unsafe-inline'` because SSR-streamed styles arrive as inline
  `<style>` tags; style injection is far lower risk than script injection.
- `X-Frame-Options: DENY` plus `frame-ancestors 'none'` — stops clickjacking of
  the OAuth consent screen and account pages.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Strict-Transport-Security` (ignored by browsers over plain HTTP, enforced
  over HTTPS).

These headers are deliberately **not** applied to hosted package apps, which
need their own looser policies to run author-authored code.

## Hosted package app origin isolation

Hosted package apps execute author-supplied HTML, JS, and worker code. In
production they run on per-user subdomains of the package-app domain
(`https://{username}.kody.run/packages/{kodyId}/...`); confirmed non-production
runtimes may serve them inline on the app origin at
`/@{username}/packages/{kodyId}/...` instead. Anything that shares an origin
with a package app is inside its reach, and package apps get no CSP backstop
(invariant 2), so the origin boundary _is_ the control.

**Threat model.** Author-supplied package code must not act as the owner, and
one user's package apps must not reach another user's browser state. If package
apps shared the app origin and the handler forwarded a clone of the original
request into the package worker, author code would have two ways to act as the
owner:

- server-side, the forwarded request would carry the owner's `kody_session`
  cookie (and any `Authorization` header), so package code could read it and
  replay it;
- client-side, a same-origin package page could
  `fetch('/account/secrets.json', { credentials: 'include' })` from author JS
  and read the owner's secrets or mutate their account.

If every user's package apps shared one origin on the package-app domain, one
owner's package could also read or plant cookies and call same-origin endpoints
for another owner's packages. That is a real vulnerability, not an accepted
risk. Three independent controls close it.

**1. Credential stripping (always on).** `createPackageCodeRequest` builds the
request package code sees without `Cookie`, `Authorization`,
`Proxy-Authorization`, or `X-Kody-*` headers. It is applied to the forwarded
HTTP request and to the realtime WebSocket upgrade, because
`PackageRealtimeSession`'s `connect` hook receives the upgrade request's
headers. This holds regardless of hosting mode, so local dev and preview are
covered too.

**2. A separate registrable domain (production).** `PACKAGE_APP_BASE_URL`
(production Worker var, `https://kody.run` — the apex; the deploy publishes apex
and wildcard **zone routes** on the runtime Worker for that host, never a
Workers custom domain in this zone — see
[`setup-manifest.md`](./setup-manifest.md)) makes package apps cross-site from
the app origin, so the `SameSite=Lax`, `HttpOnly` `kody_session` cookie never
attaches to them and cross-origin `fetch` from package pages has no CORS grant
(`withCors` only reflects same-origin, plus `/mcp`). It must stay a **separate
registrable domain**: a subdomain of the app origin would still be same-site for
cookie purposes. `getPackageAppBaseUrl` (`packages/worker/src/app-base-url.ts`)
resolves the apex origin, and `getAppBaseUrl` refuses to resolve the package-app
origin as the app origin so package runtime callbacks and first-party links
always point back at the app.

**3. Per-user subdomains (production).** Each owner's hosted apps are served
from `{username}.<package-app host>` (`buildPackageAppSubdomainOrigin` in
`packages/shared/src/public-urls.ts`), so browser state (cookies, storage,
`document` access) never crosses accounts. The username label in the hostname
must be a valid single DNS label: lowercase letters, digits, and hyphens only,
3–32 characters, alphanumeric edges (`dnsSafeUsernamePattern` in
`packages/shared/src/public-urls.ts`). Every username satisfies this shape —
underscores are rejected everywhere, and there is no lenient recognition tier
(decision 0017). Wildcard DNS still routes invalid or nested labels to the
Worker, so hostnames that are not exactly one valid username label fail closed
with `404`.

Usernames are also `{username}@<platform domain>` mail locals. The built-in
reserved list in `packages/worker/src/identity/reserved-usernames.ts` blocks
brand, infrastructure, mailbox, and trust labels (`autodiscover`, `mta-sts`,
`wpad`, system-email locals, and the rest of the denylist) so those labels
cannot become package-app subdomains or inbound mailboxes. Operators add or
unreserve names at runtime through `platform-settings:v1:reserved-usernames`
without a deploy; system-email locals and `kody`-prefixed built-in names stay
permanently locked. Signup, admin user creation, and social username generation
consult the effective set (built-in plus KV). Inbound mailbox routing
(`resolveInboundMailboxRoute`) uses only the RFC 5233 base local with
`isPermanentlyReservedUsername` / `isSystemEmailLocal` — never the plus-tag and
never the claim-denylist substring matcher — so `alice+kody@inbox…` is user mail
for `alice`.

A new claim fails when the case-insensitive (lowercase-trimmed) username is an
exact reserved token or when the hyphen/underscore-stripped form equals a
reserved token. Substring matching is narrower: only KV-added tokens and
built-in brand/system roots (`kody`, `kent`, permanent system-email locals, and
other `kody`-prefixed built-ins) block compact substrings, and only when the
compact token is length 4 or more. Infrastructure labels such as `user`, `test`,
and `help` stay exact/compact-equal only; abuse and impersonation also lean on
KV-added terms and operator discretion on [`/terms`](https://kody.codes/terms).
Underscores are stripped for matching only; stored handles still allow letters,
digits, and hyphens (3–32, alphanumeric edges). Three-letter tokens still block
exact and compact-equal claims (`f-aq` matches `faq`) but do not substring-match
(`assistant` is allowed even if `ass` is added in KV). The user-facing error is
`This username is reserved.` Accounts that already hold a colliding username
keep it at signup; `adminReservedUsernameList` `conflicts` lists those holders
when invoked. Resolve conflicts before expanding the built-in list; do not treat
`conflicts` as a mandatory post-expansion run. Operators may still change an
existing username at their discretion when a handle is abusive, reserved,
impersonating, or otherwise a problem — that policy is stated on
[`/terms`](https://kody.codes/terms). Generated usernames keep numeric suffixes
only when the preferred base is claimable but taken; a substring-eligible
reserved base skips to a random compact candidate because `support-2` still
contains `support`.

Dispatch lives in `packages/worker/src/app/package-app-origin.ts`, called first
in the Worker `fetch` handler:

- **App origin, `/@{username}/packages/*`:** never executes package code.
  Anonymous visitors and signed-in outsiders stay on the app origin. A
  session-gated app sends anonymous GET/HEAD to `/login` there. An approved
  internet-visible app shows the saved-package page when that page can link to
  the app, and a same-origin landing with that link otherwise. A signed-in
  person who may run the app still hands off: safe methods redirect (`302`) to
  the owner's package-app subdomain or verified custom hostname with a handoff
  token; other methods get a `307` to that host with no token. Retired slugs
  still `308` on the app origin.
- **Package-app apex** (`kody.run`): serves no package code. `/` redirects to
  the app origin. Legacy path-based URLs (`/@{username}/packages/*`) redirect
  (`302`/`307`) to the owning user's subdomain. Everything else — including
  `/account/*`, `/login`, `/mcp`, and the `/webhooks/*` machine API — is `404`.
  Webhook ingress stays on the app origin on purpose: it is authenticated by its
  own URL secret, it is never called by package browser code, and hosting it on
  the package-app domain would only widen its surface. Retired
  `/@{username}/connectors/*` paths also 404.
- **Per-user package-app subdomain** (`{username}.kody.run`): serves only
  `/packages/{kodyId}/*` for that hostname's username label. `/` redirects to
  the app origin; every other path is `404`.

**Handoff session and fixation defense.** The app origin mints a short-lived
single-use handoff token; the owner's subdomain exchanges it for a host-scoped
package-app session cookie (`packages/worker/src/app/package-app-session.ts`).
On secure requests the cookie is named `__Host-kody_pkg_session_<hash>` (one
name per package leaf; hash is `sha256(leaf)[0:12]`); plain HTTP local dev uses
`kody_pkg_session_<hash>` because browsers refuse `__Host-` cookies on insecure
origins. The `__Host-` prefix requires `Secure`, `Path=/`, and no `Domain`
attribute, so browsers reject any variant with a `Domain` — this blocks
cross-subdomain cookie tossing even before the package-app domain is on the
Public Suffix List. Serving additionally requires the resolved session account's
username, the subdomain label, and the path's owner username to all match
(`servePackageAppRequest` in
`packages/worker/src/package-runtime/package-app-serve.ts`), so a handoff minted
for one account cannot authorize another user's subdomain.

Sibling subdomains also stay **same-site** with each other until the domain is
on the Public Suffix List, so a `SameSite=Lax` cookie still attaches to their
cross-origin requests. In a browser holding sessions for two accounts (a shared
machine), one user's package code could otherwise send a credentialed mutating
request to the other user's app — CORS blocks the response, not the side effect.
Mutating requests on a subdomain or a package-app custom hostname therefore
require any `Origin` header to match that host; requests without one
(non-browser clients, synthetic dispatch) authenticate through their own paths.
`OPTIONS` is not part of that block: it is the CORS preflight and is forwarded
to the app. If the app handler throws on `OPTIONS`, the platform answers `204`
instead of the package-entrypoint crash page. Same-site credentialed GETs remain
possible until the PSL entry lands; package apps must not mutate on GET, which
HTTP already demands. Cross-origin `POST`, `PUT`, `PATCH`, and `DELETE` stay
`403`.

- **No redirect cycle:** the app origin only ever redirects _to_ a package-app
  subdomain, the apex only redirects to a subdomain or the app origin, and a
  subdomain only redirects within itself to drop a consumed token from the URL
  (plus its bare `/`, which goes home to the app origin — a terminal hop, not
  part of the handoff). A package-app request with no usable session terminates
  in a `403` that links back to the app origin, so a browser that refuses the
  cookie fails visibly instead of ping-ponging between hosts.

Production fails closed with `500` before executing package code when
`PACKAGE_APP_BASE_URL` is missing, invalid, equal to `APP_BASE_URL`, or on the
same registrable domain. There is no production inline fallback.

Preview, tests, E2E, and `npm run dev` may keep serving package apps inline when
no package-app origin resolves. That path is still credential-stripped, but it
is same-origin, so **do not treat a non-production inline run as representative
of the production isolation boundary**. To exercise the two-origin flow locally,
set `PACKAGE_APP_BASE_URL=http://packages.localhost:<port>` in
`packages/worker/.env`.

The cross-site handoff (how the owner is recognized on the package-app subdomain
without giving package code a first-party session) is documented in
[`architecture/authentication.md`](./architecture/authentication.md#package-app-origin-handoff).

Because hosted package apps are served from this deployment's own origins, code
that decides whether a URL is "ours" must accept every production shape.
`parsePackageSearchIdentity`
(`packages/worker/src/mcp/tools/package-search-identity.ts`) accepts a
`https://{username}.<package-app host>/packages/{kodyId}` URL, a
`/@{username}/packages/{kodyId}` URL on the app or package-app apex, and
`/account/packages/{packageId}` on the app origin — so a URL copied out of a
running package app resolves to that package — while other `/account/*` paths
stay app-origin only. Untrusted markdown is the opposite case:
`getSafeMarkdownLinkHref` refuses any `/@...` user-scope path and any
`/packages/...` package-app mount path regardless of host, so a community README
cannot link into either origin's package surface.

**Out of scope (deliberate).** User-to-user isolation is complete: each owner's
apps run on a distinct origin. Two packages owned by the **same** user still
share that user's subdomain origin, so one of that owner's package apps can
reach another's `__Host-kody_pkg_session`-authorized endpoints from the browser.
That is a smaller blast radius than first-party access (all of it stays inside
one owner's own data, since serving is `userId`-scoped and the session is bound
to one account), but it is not zero.

**Operational follow-up (not code).** Submit `kody.run` to the
[Public Suffix List](https://publicsuffix.org/submit/) for defense-in-depth
(sibling subdomains treated as separate registrable domains by browsers). That
requires a `_psl` TXT record on the zone and a PR to
[publicsuffix/list](https://github.com/publicsuffix/list) by the domain owner,
plus 2+ years remaining on the registration. Abuse/contact mail is
`psl@kody.codes`, a reserved operator system inbox (same storage as `abuse@` and
`security@`). Do not enable `allowPrivateDomains` on tldts:
`readPackageAppZoneName` must keep resolving the public-suffix zone without the
PRIVATE list. The `__Host-` cookie is the primary cookie-tossing control; PSL
entry is an additional layer.

## Non-canonical hosts

All three product workers keep `workers_dev = true` so secret bulk-reapply does
not drop zone routes. That leaves a second hostname (`*.workers.dev`) pointing
at the same scripts as `kody.codes` and `kody.run`. WebAuthn `rpID` derives from
the request host, and CSP/CORS reasoning assumes one origin, so production must
not serve the app, `/mcp`, or OAuth on that trigger.

`refuseNonCanonicalProductionHost` (`packages/worker/src/app/canonical-host.ts`)
runs at the start of origin, platform, and runtime `fetch`. In production
(`!isNonProductionRuntime(env)`), a request whose host is not the `APP_BASE_URL`
host, not a package-app apex or `{username}.<package-app host>` shape
(`parsePackageAppRequestHost` / `getPackageAppBaseUrl`), and not an
`APP_LEGACY_HOSTS` entry, receives `404` `{ error: 'not_found' }` with
`Cache-Control: no-store`. Preview, local, and test runtimes skip the check
because preview URLs are `*.workers.dev`.

Deploy health checks hit the origin at `APP_BASE_URL/health` when that var is
set, and fall back to the workers.dev URL from `wrangler deploy` output.
Platform and runtime health checks always use the workers.dev URL
(`/__platform/health`, `/__runtime/health`). Those exact probe paths stay
reachable on any host; every other workers.dev path in production is `404`.

## Auth rate limiting

Credential-accepting POST endpoints share one per-IP auth rate-limit bucket
(`auth:ip:<ip>`, `packages/worker/src/app/rate-limit.ts`, default 10 requests
per 60-second window). Deployed environments use the Cloudflare rate-limit
binding (`AUTH_RATE_LIMITER` in `packages/worker/wrangler.jsonc`); local dev,
tests, and self-hosted configs fall back to a D1 atomic limiter. Production
fails closed: env validation (`packages/worker/src/app/env.ts`) rejects a
production runtime without the binding, so the D1 fallback can never silently
become the production limiter. The shared bucket means brute-force attempts
cannot fan out across parallel paths. Covered paths (`rateLimitedAuthPaths` in
`packages/worker/src/origin-handler.ts`):

- `POST /auth` (password login/signup)
- `POST /auth/github`, `POST /auth/google`, `POST /auth/x`, `POST /auth/discord`
  (social login start)
- `POST /oauth/authorize` (inline OAuth login)
- `POST /password-reset` (reset request)
- `POST /password-reset/confirm` (reset confirmation)
- `POST /account/password.json` (signed-in password change or first-time set)
- `POST /verify/2fa.json` and `POST /account/two-factor.json` (two-factor)
- `POST /webauthn/authentication` (passkey authentication)

Public signup requires Turnstile in production: both `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` must be set or the worker refuses to boot. If either key
is missing at request time, public forms refuse with a `503` (reported to
Sentry) instead of failing open. Local development (`WRANGLER_IS_LOCAL_DEV`),
previews, and tests may omit the keys and skip the challenge — including when
local generated wrangler still copies `SENTRY_ENVIRONMENT=production`.

Excess requests receive `429 Too Many Requests` with a `Retry-After` header. The
D1 approach uses a batched INSERT + COUNT in a single transaction, avoiding the
read-then-write race that KV-backed limiters suffer under concurrency.

## Sentry tunnel rate limiting

`POST /sentry-tunnel` is unauthenticated and exempt from cross-origin
protection, and its DSN check authorizes nothing: a Sentry DSN ships inside the
client bundle. The forward target is always derived from the Worker's own
`SENTRY_DSN`, so the exposure is ingestion quota and a polluted error stream
rather than an open proxy. The handler therefore consumes a per-IP bucket
(`sentry-tunnel:ip:<ip>`, 120 requests per 60-second window) before it buffers
the body, using the `SENTRY_TUNNEL_RATE_LIMITER` binding when deployed and the
same D1 limiter elsewhere. The ceiling clears steady error-replay traffic from
one browser while capping a scripted flood. Requests without a `content-length`
header are refused with `411 Length Required` so no unbounded body is read
before the 10 MB cap can apply.

## Password policy

Signup, password-reset confirmation, and signed-in password change enforce a
minimum password length via `@kody-internal/shared/password-policy.ts`. The
server is the trust boundary; the browser hint is advisory. Login does not
re-check length, so existing accounts are never locked out.

## OAuth / MCP hardening

- PKCE is validated at the application layer: `getPkceValidationError`
  (`packages/worker/src/oauth-handlers.ts`) rejects an authorize request whose
  `code_challenge_method` is anything other than `S256` when a `code_challenge`
  is present. Plain PKCE offers no protection against code interception.
  `@cloudflare/workers-oauth-provider` is S256-only (no `allowPlainPKCE`). Keep
  the app-layer check; plain PKCE cannot be re-enabled.
- Dynamic client registration (`/oauth/register`) is intentionally **open**: the
  MCP OAuth spec requires it, and clients (including native/public clients using
  PKCE) rely on it. This is a deliberate acceptance, not a gap. Do not add
  `disallowPublicClientRegistration` without a plan for how MCP clients
  register.
- `/mcp` requires a bearer token whose audience matches the origin
  (`packages/worker/src/mcp-auth.ts`).

## MCP denial visibility

MCP authentication and authorization denials are recorded in `audit_events`
(`category: 'auth'`, `result: 'failure'`) via `recordMcpAuthDenial`
(`packages/worker/src/mcp/auth-audit.ts`), not in Sentry. Browser auth events
(signup, login, 2FA, password reset, passkeys, verification, and account
credential changes) persist to the same `audit_events` table through
`logAuditEvent` with `db: auditDatabaseFromEnv(env)`. A single denial is a
routine agent turn, so it is not an error; a burst from one principal is how
permission probing or a compromised account would look, and the audit log is the
surface built for that — hashed identifiers, 180-day retention, an admin-only
query (`adminAuditLogQuery`), and the failure-per-day and failure-per-hour
charts on `/admin/insights`. Two sites record:

- `handleMcpRequest` rejecting a resolved grant (`mcp_token_rejected`):
  unidentifiable grant, unverified email, suspended account.
- `assertCallerCanAccessCapability` refusing a capability
  (`mcp_capability_denied`): missing user, role, permission, or feature flag.
  This is the single choke point every capability call passes through, so it
  covers the whole authorization surface.

An hourly cron lane (`auth_denial_alert` in `packages/worker/src/scheduled/`,
implemented by `checkAuthDenialBurstAndNotify` in
`packages/worker/src/app/auth-denial-alerts.ts`) fans `auth.denial.burst` to
admin-owned packages when MCP auth denials in the last 60 minutes cross a
threshold (default 50). A KV cooldown prevents re-paging on the same sustained
spike. Charts on `/admin/insights` remain the browse surface; the event is the
input a notifier package can page from.

A second hourly lane (`email_delivery_alert`, implemented by
`checkEmailDeliveryBurstAndNotify` in
`packages/worker/src/app/email-delivery-alerts.ts`) fans `email.delivery.burst`
when platform-wide Cloudflare Email Sending outcomes of `complained` or
`bounced` in the last 60 minutes cross a threshold (default 20). Those match the
outbound-abuse reputation signals (`failed` / `rejected` are not counted).
Cooldown is 6 hours via `BUNDLE_ARTIFACTS_KV`. This complements the per-user
outbound pause in `outbound-abuse.ts` — that path stops one account; the cron
pages when the shared sending domain is under platform-wide pressure. Review the
Email delivery health chart on `/admin/insights`.

A third hourly lane (`email_verification_stall_alert`, implemented by
`checkEmailVerificationStallsAndNotify` in
`packages/worker/src/app/email-verification-stall-alerts.ts`) fans
`user.email_verification.stalled` when an unverified person account's latest
signup/verify send is still `accepted` after 60 minutes with no Cloudflare
lifecycle event. The scan pages 50 rows at a time and advances a
`BUNDLE_ARTIFACTS_KV` watermark so later sends are not starved. Terminal bounces
still use `user.email_verification.failed`; this lane covers silent drops that
never produce a bounce.

**Deliberately not recorded:** rejections that happen before a grant resolves —
a missing, empty, or unparseable bearer token. Those are reachable by any
anonymous request, so auditing them would let a stranger drive unbounded D1
writes, and "someone sent a bad token" is not attributable to a principal. The
consequence is that **brute-forcing or replaying tokens against `/mcp` does not
appear in the audit log**; flood control for anonymous traffic belongs at the
edge (Cloudflare rate limiting / WAF), not in application writes.

## Retired connector routes

Former user-scoped connector ingress (`/@{username}/connectors/...` and
`/connectors/...`) is removed. Those paths return `404` for every method,
including WebSocket upgrades. Home automation and other outbound tools use
normal user-added MCP servers (`kody.mcp["name"]`) instead.

## Maintenance route guard

Any `/__maintenance/*` path that does not match a known handler returns `404`
with a JSON body. This prevents unhandled maintenance paths from falling through
to the SPA shell and silently returning `200 OK`. Known maintenance handlers are
guarded by a bearer secret comparison.

## Secrets and user code execution (in-scope model)

- Saved secrets are encrypted at rest with AES-GCM under `SECRET_STORE_KEY` and
  scoped by `userId` (`packages/worker/src/mcp/secrets/`). Ciphertexts are
  `v2.<iv>.<ct>` and bound via AES-GCM additional authenticated data to their
  purpose and owning identity (`user:<userId>` for user secrets, `app:<slug>`
  for platform OAuth client secrets), so a ciphertext copied into another user's
  row fails to decrypt. Integration-owned OAuth tokens and user-lane client
  secrets live only as ciphertext on `user_integrations` / `user_oauth_apps`;
  they are not stored in `secret_entries`. Row swaps already require write
  access to the database, so AAD binding is defense-in-depth, not a standing
  hole.
- `SECRET_STORE_KEY` is escrowed for disaster recovery as a passphrase-sealed
  blob in the DR backup bucket (solo operator; see
  [Disaster recovery](./disaster-recovery.md) and
  [Secret rotation](./secret-rotation.md)). The plaintext key must not appear in
  backup SQL, manifests, or repository files.
- Outbound secret use goes through the fetch gateway
  (`packages/worker/src/mcp/fetch-gateway.ts`), which is deny-by-default: a
  credential placeholder is filled only for a host the credential allows (a
  secret's hosts the user approved in the account UI, an integration's
  `requiredHosts` and `apiBaseUrl` host, a vault item's websites) and only over
  HTTPS. It may sit in a header, the URL path or query, a text body (JSON values
  are JSON-escaped, form values form-encoded), or a literal `{{…}}` in a
  `multipart/*` part. Streamed bodies are filled chunk by chunk. A
  percent-encoded or base64-encoded placeholder form the gateway will not fill
  is refused. Percent-encoded placeholders in the URL path or query, and in
  form-urlencoded components the gateway already fills, stay supported. A
  placeholder on plain HTTP, in the URL host or user info, or bound for a host
  the credential does not allow is refused before anything resolves
  (`packages/worker/src/mcp/secrets/secret-placement.ts` and the credential
  door), so none is sent unfilled. The values are redacted from echoes in the
  response (also URL-, form-, and JSON-encoded) and from fetch errors.
  `x-kody-secret-resolution: headers-only` fills headers only, for a body that
  quotes the syntax; `off` skips resolution entirely. The control header is
  stripped before the request leaves, on both the gateway and local native fetch
  paths. Policy writes (allowed hosts/capabilities/ packages) are only reachable
  through the authenticated account UI.
- User code runs in a Cloudflare Worker Loader isolate without the parent `env`;
  capabilities are RPC'd back to handlers that enforce the caller's `userId`.
- The DR control-plane Admin UI is protected by Cloudflare Access plus in-worker
  `Cf-Access-Jwt-Assertion` verification; production restore is a graduated
  prepare → typed confirmation → Workflow path, never a single click.

## Inbound email spam controls

Inbound mail is classified at receive time (`accepted` or `quarantined`) before
package subscription dispatch. Authentication-Results are decided first (DMARC
fail, or SPF fail/softfail without DKIM pass → suspect; missing header fails
open). Per-user sender rules then apply against the RFC5322 From (exact address
or domain with subdomain matching; address rules beat domain rules; SMTP `block`
still matches the envelope): `block` rejects at SMTP before quota is charged,
`quarantine` stores as flagged, `allow` accepts only when From authenticates
(DMARC pass or aligned SPF) — spoofed or unaligned From is never accepted
because of an allow rule. When no rule matches, suspect mail is quarantined and
other mail is accepted. Accepted user mail dispatches `email.message.received`;
quarantined user mail dispatches `email.message.quarantined` instead.
`emailReply` refuses a quarantined inbound message (`quarantined_inbound_reply`)
before any send or daily send quota is used, so a reply cannot backscatter to a
spoofed sender. Release it with `emailMessageClassify` (classification
`accepted`) or Not spam on `/@<slug>/-/email`, then reply. Quarantined operator
system-inbox mail is stored but suppresses `email.system-message.received`.
Before user-inbox dispatch, `classifyInboundEmailSender` decides the sender. A
verified, authenticated account email of a current org member is `member` (only
packages they hold `package:execute` on are considered). Any other From that
authenticates by DMARC pass or aligned SPF is `inbox-owner`. Packages run only
when a per-sender enablement matches; the run acts as that enablement's enabler,
with credentials checked and audited under them. DKIM-only, a missing
Authentication-Results header, failed auth, a missing From, or a spoofed member
address runs nothing and logs `inbound-email-sender-unverified`. Successful
reserved-sender sends fan `email.system-message.sent` (admin-only) with the sent
correspondence. Reclassification never retroactively fires subscription events.
Users manage rules via `email_sender_rule_*` (200-rule cap), reclassify via
`emailMessageClassify` or `/@<slug>/-/email`, and delete stored messages via
`emailMessageDelete` or the delete action on `/@<slug>/-/email`; operators use
`admin_system_email_sender_rule_*` for system inboxes. Upstream, Cloudflare
Email Routing already rejects mail failing both SPF and DKIM and honors sender
DMARC policy.

## Abuse controls (suspension, email pause, compute quotas)

One bad actor can poison shared platform identity — every user sends mail from
one platform domain through one Cloudflare Email Sending account, and every
sandbox fetch leaves through the same Worker egress. Three controls bound that
blast radius:

- **Platform suspension (`users.suspended_at`).** An admin-set kill switch,
  distinct from a community ban (which only blocks community-surface actions).
  Enforced fail-closed at every chokepoint: browser session resolution
  (`readAuthenticatedAppUser` / `loadSessionInfo` treat a suspended session as
  signed out), MCP bearer auth (`handleMcpRequest` returns a 403
  `account_suspended` response, mirroring the email-verification gate),
  package-app owner resolution, webhook ingress (403 `account_suspended`,
  recorded as a rejected delivery), background work, and both email directions
  (inbound storage rejects with a bounded `account-suspension` rejection event;
  outbound send throws). Background lanes — jobs, package invocations and
  subscriptions, workflows, retrievers, and realtime hooks — share one choke
  point: `resolveBackgroundMcpUser` throws `AccountSuspendedError`, which
  package invocations surface as 403 `account_suspended` and workflow steps
  raise as a non-retryable failure. That resolver caches identities per isolate
  for 60 seconds, so a new suspension can take up to that long to stop
  background work already warm in an isolate. Set and cleared through the
  audited `suspend_user` / `unsuspend_user` actions on `POST /admin/users.json`.
- **Automatic outbound-email pause (`orgs.email_outbound_paused_at`).** The
  delivery queue evaluates provider delivery events
  (`packages/worker/src/email/outbound-abuse.ts`): one spam complaint, or five
  or more bounced sends within a UTC day, pauses that account's outbound email
  and fans `user.email_outbound.paused` to admin-owned packages. The pause write
  is idempotent (only transitions NULL), the send path rejects while paused, and
  the audited `resume_email_outbound` admin action clears it after review. The
  `/admin/insights` "Email delivery health" chart shows platform-wide outcome
  trends so reputation trouble is visible before providers act on it. The hourly
  `email_delivery_alert` cron fans `email.delivery.burst` on a platform-wide
  spike (see above) without replacing this per-user pause.
- **Compute quotas.** `execute_unique_workers_per_day` (new sandbox workers, the
  billed unit) and `outbound_fetches_per_day` entitlements bound sandbox compute
  and egress per org per UTC day, with public-ladder weekly hard caps on the
  same meters (Monday–Sunday; whichever window hits first blocks). Warm repeats
  are bounded separately by a per-org execute runaway brake (300 calls per
  minute per paid seat, raised by admin overrides). See
  [`architecture/entitlements.md`](./architecture/entitlements.md).

## Accepted residual risks and out-of-scope items

These were reviewed and intentionally left as-is for this project. Document any
change to these decisions here so future agents do not relitigate them.

- **Stateless sessions revoke after a password change and expire at the absolute
  lifetime.** `kody_session` is a signed cookie with no server store, so there
  is no separate "log out everywhere" button. Password reset confirmation and
  signed-in password change (`POST /account/password.json`) both revoke every
  MCP OAuth grant for the user, stamp `users.password_changed_at`, then revoke
  again. Password-reset confirmation also disables TOTP, deletes passkeys, and
  deletes `oauth_connections`. Browser and package-app sessions carry
  `issuedAt`; `resolveRequestAuth` rejects cookies issued at or before that
  timestamp (missing `issuedAt` fails closed once a password change exists) and
  also rejects cookies whose `issuedAt` plus the cookie TTL (7 days, or 30 with
  remember-me) is in the past, clearing the cookie the same way as a
  password-change revocation. A cookie that omits `issuedAt` is treated as
  already expired. Package-app sessions expire server-side via `expiresAt` (12
  hour fallback from `issuedAt` when the field is missing). `/mcp` applies the
  password-change timestamp to the access token `createdAt` (Unix seconds) so
  already-issued bearers fail closed as `invalid_token`; MCP bearer lifetime
  stays the OAuth provider TTLs. A signed-in password change re-issues the
  current browser cookie so that tab stays signed in; every other session still
  dies. Reclaiming an unverified account on a provider-verified social match
  uses the same `password_changed_at` lockout.
- **OAuth authorize client reset is grant-scoped.** A signed-in user can reset a
  mismatched DCR client for **their** grants only. `deleteClient` runs only when
  `user_mcp_oauth_clients` shows they own that registration. Shared host clients
  (Cursor, Claude, Gemini) stay registered for other users.
- **Account secret reveal is owner-scoped, not password-reauthenticated.** See
  the "Account secret reveal" section of
  [`architecture/authentication.md`](./architecture/authentication.md).
- **Signup does not confirm whether an email is registered, except through the
  session cookie.** `POST /auth` with `mode: signup` for an address that already
  has an account returns the same `200` body as a fresh signup
  (`emailVerificationRequired: true`), creates nothing, sends nothing, and
  audits `signup` / `email_exists`. Only the fresh signup carries a
  `Set-Cookie: kody_session` header, so a scripted caller that inspects headers
  can still distinguish the two; the shared per-IP auth rate limit bounds that
  probing to 10 attempts a minute. Closing the header side channel means not
  issuing a session at signup at all (session on verification instead), which is
  a larger onboarding change than the copy-level fix. Usernames are public
  identifiers, so a duplicate username still returns `409`.
- **Turnstile tokens must come from the request's own hostname.**
  `verifyPublicFormProtection` rejects a siteverify success whose `hostname`
  differs from the request URL's hostname (logged as
  `turnstile-hostname-mismatch`), so a token minted on a preview deployment or a
  third-party page embedding the same sitekey is not accepted on production.
- **Sandbox `fetch` has no general SSRF denylist.** Secret-bearing requests are
  constrained by per-secret host allowlists; non-secret requests rely on the
  Cloudflare Workers platform egress model.
- **PBKDF2-SHA256 (100k iterations)** is used for password hashing rather than a
  memory-hard KDF. Workers' WebCrypto has no argon2/scrypt, and Cloudflare's
  production runtime rejects PBKDF2 above 100,000 iterations (deriveBits throws
  `NotSupportedError`; local workerd does not enforce the cap), so 100k is the
  strongest setting the platform allows — below OWASP's 600k PBKDF2-SHA256
  guidance. Iteration counts above the runtime cap are rejected during
  verification (they could never derive in production), and lower-iteration
  hashes are transparently re-hashed after a successful login
  (`packages/worker/src/password-upgrade.ts`), so the setting can be raised
  without a migration if the platform cap ever lifts.
- **No CSRF tokens.** State-changing requests are protected by `SameSite=Lax`
  cookies plus JSON `Content-Type` on mutating endpoints. This is a deliberate
  decision, restated as invariant 10 above: it holds only while both halves
  hold, so revisit if any mutating endpoint starts accepting cross-site form
  posts or `SameSite=None`.
- **Production `workers.dev` health probes stay reachable.** Origin `/health`,
  platform `/__platform/health`, and runtime `/__runtime/health` answer on the
  workers.dev trigger so deploy and status probes can hit the script directly.
  The rest of those hostnames return `404`.
- **Role, membership, and billing actions need a live person.** Every member,
  role, invite, or member/billing grant change declares `requiresLivePerson`, so
  a job, webhook, subscription, or inbound email run (and package code it
  starts) is denied even when its enabler is an Owner
  ([#2393](https://github.com/kody-hq/kody/issues/2393)). See
  [Capabilities that need a live person](./architecture/authorization.md#capabilities-that-need-a-live-person).
- **Site-admin tools run from automation only for a site admin, and are
  audited.** Background package runs resolve the owner's roles with a short
  cache (`packages/worker/src/identity/background-mcp-user.ts`), so a triggered
  run that calls a site-admin capability also re-reads the role for the person
  it acts for from D1, and every such call writes an `admin` audit row naming
  the trigger type and id. See
  [Site-admin capabilities from triggered runs](./architecture/authorization.md#site-admin-capabilities-from-triggered-runs).
- **Package inbound webhook replay protection is opt-in.** HMAC over the raw
  body without a `replay` declaration does not bind a timestamp or delivery id,
  so a captured signed payload can be replayed until the URL secret is rotated.
  Authors opt in per webhook with `replay.timestampHeader` and/or
  `replay.deliveryIdHeader`.
