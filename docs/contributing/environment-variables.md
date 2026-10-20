# Environment variables

Use this guide when you add a new environment variable to the worker app. It
keeps types, runtime validation, and documentation in sync.

## Steps

1. **Add the type**
   - Update `packages/worker/src/env-schema.ts` so the worker schema and
     `AppEnv` include the new variable.
   - `packages/worker/env.d.ts` extends `Env` from that worker-owned schema.

2. **Validate at runtime**
   - Add the variable to the runtime schema in
     `packages/worker/src/env-schema.ts`.
   - `packages/worker/src/app/env.ts` uses the schema to fail fast at runtime.
   - The schema is the single source of truth for validation + types.

   The schema is built with `remix/data-schema` (`createSchema`, `object`,
   `string`), not Zod. Example:

   ```ts
   export const EnvSchema = object({
   	COOKIE_SECRET: string().refine(
   		(value) => value.length >= 32,
   		'COOKIE_SECRET must be at least 32 characters for session signing.',
   	),
   	THIRD_PARTY_API_KEY: string().refine(
   		(value) => value.length > 0,
   		'Missing THIRD_PARTY_API_KEY. Go to https://example.com/ to get one.',
   	),
   })
   ```

3. **Add local defaults**
   - Update `packages/worker/.env.example` (source for new local
     `packages/worker/.env` files).

4. **Update required resources docs**
   - Add the variable to `docs/contributing/setup-manifest.md`.

5. **Sync deploy config**
   - Add the variable to the relevant GitHub Actions workflows so it is passed
     to Wrangler as a Worker var or secret, depending on sensitivity:
     - `.github/workflows/deploy.yml` (production deploys)
     - `.github/workflows/preview.yml` (preview deploys)
   - Secrets that platform, runtime, or jobs workers read must be synced onto
     those sibling scripts as well as origin. A secret only on `kody-production`
     is invisible to `kody-platform` / `kody-runtime` / `kody-jobs`. See
     [architecture](architecture/index.md#production-worker-fleet).

## Sentry

Optional Worker secret and vars (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/sentry-options.ts`):

- `SENTRY_DSN` — ingest URL from your Sentry project. When unset, the Worker
  skips `Sentry.withSentry`; Durable Objects use the same options builder and
  will not send events without a DSN. The DSN (a publishable client key) is also
  exposed to the browser via the `kody:sentry` meta tag to enable client error
  capture and error-only session replay through the same-origin `/sentry-tunnel`
  route.
- `SENTRY_ENVIRONMENT` — also set as a Wrangler `var` per environment in
  `packages/worker/wrangler.jsonc` for deploys.
- `SENTRY_TRACES_SAMPLE_RATE` — optional `0`–`1`; defaults to **`1.0`** (sample
  all traces) when unset. Production pins it to `0` as a Wrangler `var` in
  `packages/worker/wrangler.jsonc` because Workers native tracing already
  exports OTLP traces to Sentry and duplicate SDK traces would double quota
  usage; error reporting is unaffected. The Sentry options builder reads the raw
  runtime env and only honors a **number**, so configure it as a JSON-number
  `var`, not a string secret.

## Fathom Analytics

Optional Wrangler `var` (public, non-secret; see
`packages/worker/src/env-schema.ts` and
`packages/worker/start/routes/__root.tsx`):

- `FATHOM_SITE_ID` — the Fathom Analytics site id. When set, SSR pages embed the
  Fathom tracker script (`https://cdn.usefathom.com/script.js` with
  `data-spa="auto"` so SPA navigations are tracked). Production sets it in
  `packages/worker/wrangler.jsonc`; it is intentionally unset for local dev,
  preview, and tests so those environments never send pageviews. The CSP in
  `packages/worker/src/app/security-headers.ts` allowlists
  `https://cdn.usefathom.com` in `script-src`, `img-src`, and `connect-src` for
  the tracker, its image pageview beacon, and `sendBeacon` duration/event pings.
  After a production domain change, add the new hostname to the site's Firewall
  → Domains **Allow** list (Settings → Sites → site → Firewall). A leftover
  `heykody.*` Allow list discards `kody.codes` pageviews while the collect GIF
  still returns 200. The API token cannot read or write that list. `connect-src`
  is required for `sendBeacon` duration/events, not for the image pageview
  beacon.

## Scarf

No Wrangler var. The client pixel id lives in
`packages/worker/client/scarf-analytics.ts`. It fires only on
`https://kody.codes` public marketing and docs paths (homepage, pricing, FAQ,
case studies, community, blog catalog slugs, and official docs slugs). Preview,
local, and other hosts never send. The pixel includes the public path and no
query string, fragment, referrer, or account id. Global Privacy Control and Do
Not Track skip the request. The CSP in
`packages/worker/src/app/security-headers.ts` allowlists
`https://static.scarf.sh` in `img-src` only.

## YouTube watch overlay

Optional Wrangler vars (public, non-secret; see
`packages/worker/src/env-schema.ts` and
`packages/worker/universal/youtube-watch.ts`):

- `YOUTUBE_ALLOWED_PLAYLIST_IDS` — comma-separated playlist ids. The Worker
  reads each playlist's public Atom feed (latest ~15 videos) and caches it about
  an hour. `none` disables playlists. Unset skips playlist fetch so tests stay
  offline. Production and preview set Kent's public playlist in
  `packages/worker/wrangler.jsonc`.
- `YOUTUBE_ALLOWED_VIDEO_IDS` — comma-separated extra video ids, merged with
  playlist items, the look-preview sample id, homepage hero chooser ids, and ids
  extracted from enabled banner hrefs.

Optional origin-only Worker secret (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/app/landing-hero-videos.ts`):

- `YOUTUBE_DATA_API_KEY` — YouTube Data API key for the homepage hero chooser
  (`playlistItems`, playlist order). When unset, the Worker reads the same
  unlisted playlist through YouTube's public browse endpoint. Production deploy
  syncs it onto origin only (`--set-from-env-optional YOUTUBE_DATA_API_KEY`).
  Platform, runtime, and jobs workers do not read it.

The overlay itself is `/?youtubeId=<id>`. Thumbnails are proxied at
`/youtube-thumb/<id>` so `img-src` can stay first-party.

## Build metadata

Optional Wrangler vars set by the production and preview deploy workflows (see
`packages/worker/src/deploy-info.ts` and `tools/ci/build-deploy-info.ts`):

- `APP_COMMIT_SHA` — the git SHA being deployed. `GET /health` reports it as
  `commitSha` so post-deploy healthchecks can pin the version. Also used as the
  Sentry **release**.
- `APP_DEPLOY_INFO` — base64url JSON (raw JSON is also accepted) with the commit
  message and date, repo/PR links, and the GitHub Actions run that deployed.
  `GET /health` decodes it; invalid values are ignored so a bad var cannot take
  the worker down. Unset in local dev.

## App origin and domain migration

Wrangler `vars` (public and non-secret; see
`packages/worker/src/app-base-url.ts`,
`packages/worker/src/app-legacy-redirect.ts`, and `tools/ci/resource-utils.ts`):

- `APP_BASE_URL` — the canonical public app origin (`https://kody.codes` in
  production, set as a GitHub Actions repository variable and injected by the
  deploy). Unset for local dev and set to the ephemeral worker URL for previews.
  The deploy derives a Workers `custom_domain` route from it, and
  `getCanonicalAppBaseUrl` uses it for canonical/OG URLs in SSR HTML.
- `APP_LEGACY_HOSTS` — optional comma-separated additional app hostnames that
  remain attached and dual-served alongside `APP_BASE_URL`. The generated deploy
  `routes` list **replaces** the Worker's entire custom-domain set, so every
  dual-served host must be listed here — otherwise the next deploy detaches
  omitted origins and deletes their DNS records. Set as a GitHub Actions
  repository variable. Production leaves this unset.
- `APP_LEGACY_REDIRECT` — exact string `true` enables path-and-query-preserving
  `308` redirects from legacy hosts to the canonical origin for browser GET/HEAD
  navigation only. Protocol surfaces are never redirected: `/mcp` (clients POST
  and do not follow redirects), `/oauth/*` and `/.well-known/*` (origin-exact
  metadata, Tesla public key), `/auth/*` and `/webauthn/*` (per-origin callbacks
  and passkey `rpID`), `/connect/oauth`, `/health*`, `/__maintenance/*`,
  webhooks, and package invocation APIs. Leave unset to dual-serve legacy hosts
  without redirecting browser navigation.

## Hosted package app origin

Wrangler `var` (public and non-secret; required in production, optional in
confirmed non-production runtimes; see `packages/worker/src/app-base-url.ts` and
`packages/worker/src/app/package-app-origin.ts`):

- `PACKAGE_APP_BASE_URL` — the **apex** origin of the package-app domain that
  hosted package apps are served from. Production sets `https://kody.run` in
  `packages/worker/wrangler.jsonc`, and the deploy publishes **zone routes** for
  the apex (`<apex-host>/*`), the per-user wildcard (`*.<apex-host>/*`), and the
  SaaS catch-all (`*/*`) on the runtime Worker — never a custom domain in this
  zone (replacing a zone's route table detaches its custom domains and deletes
  their DNS records). Zone routes do not create DNS records, so production CI
  ensures proxied placeholder records for the apex, wildcard, and
  `domains.<apex-host>` (Cloudflare for SaaS origin / customer CNAME target)
  separately (see [setup-manifest.md](./setup-manifest.md)). Each owner's apps
  are addressed at `https://{username}.<apex-host>/packages/{leaf}/...`; the
  apex itself serves only redirects (legacy `/@user/packages/...` paths to the
  owning subdomain, `/` to the app origin). It **must be a separate registrable
  domain** from `APP_BASE_URL`: that is what makes author-supplied package code
  cross-site, so the `SameSite=Lax` `kody_session` cookie never reaches it.
  Production origin validation also requires `APP_BASE_URL` so this relationship
  can be checked at runtime. Production returns `500` for package-app requests
  when this value is missing, invalid, equal to `APP_BASE_URL`, or on the same
  registrable domain; it never falls back to inline serving. Preview, tests, and
  E2E may leave it unset and keep serving package apps inline on the app origin
  at `/@{username}/packages/*`.

  `npm run dev` runs the **production** Wrangler environment, so the committed
  production value reaches local dev too; `getPackageAppBaseUrl` ignores an
  origin a local server cannot answer on, which keeps `npm run dev` inline. Set
  `PACKAGE_APP_BASE_URL=http://packages.localhost:<port>` in
  `packages/worker/.env` to exercise the two-origin flow locally. See
  [Hosted package app origin isolation](./security.md#hosted-package-app-origin-isolation).

- `PACKAGE_APP_LEGACY_HOSTS` — optional comma-separated dual-served package-app
  apex hostnames alongside `PACKAGE_APP_BASE_URL`. Generated runtime zone routes
  replace the Worker's whole route set, so every dual-served package-app host
  must be listed here — otherwise the next deploy detaches omitted origins and
  deletes their DNS records. This variable may also be set as a GitHub Actions
  repository variable (non-empty overlay wins). Production leaves this unset.
- `PACKAGE_APP_LEGACY_REDIRECT` — exact string `true` enables path-and-query-
  preserving `308` redirects from dual-served package-app **user subdomains**
  (`{username}.<legacy-apex>` → `{username}.kody.run`) for browser GET/HEAD
  only. Leave unset to dual-serve: package-app session cookies use the `__Host-`
  prefix, so they are host-only and cannot follow a redirect. Apex `/` on a
  dual-served package-app host redirects to the app origin (`kody.codes`); it is
  never sent to the canonical package-app apex. Dual-serve is the default; set
  this GitHub Actions repository variable to `true` only when enabling those
  GET/HEAD redirects. Production leaves this unset.

Worker secret (optional; see `packages/worker/src/app/package-app-ticket.ts`):

- `PACKAGE_APP_TICKET_KEYS` — comma-separated HMAC keys (each at least 32
  characters) for package-app access tickets: the short-lived (90 s) host-only
  cookie that lets repeat requests skip the access check. Every listed key
  verifies a ticket and the first one signs new tickets. Synced to the origin
  and runtime Workers by `deploy.yml`. When unset, a key is derived from
  `COOKIE_SECRET` under a purpose label, which is what preview, tests, and E2E
  use. Rotation:
  [secret-rotation.md](./secret-rotation.md#rotating-package_app_ticket_keys).

Worker variable (optional; see
`packages/worker/src/package-runtime/package-app-usage-breaker.ts`):

- `PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT` — positive number: the percent of
  the existing usage limit (monthly include stop or org budget) at which the
  package-app usage circuit breaker opens. Unset means `100`, which trips
  exactly when the usage check denies. The check only denies past the limit, so
  values below `100` behave like `100`. Values above `100` keep serving through
  a grace margin. Set it as a JSON number in the production `vars` blocks of
  both `packages/worker/wrangler.jsonc` and
  `packages/runtime-worker/wrangler.jsonc`, because both Workers serve package
  apps.

## MCP `execute` and outbound HTTP

MCP `execute` runs sandboxed JavaScript with a global `fetch`. Calls to
third-party APIs can use stored secrets via `{{secret:name}}` placeholders in
request headers over HTTPS. Host allowlists and capability policies apply per
secret. There are no GitHub-specific Worker environment variables.

## Social login (GitHub / Google / X / Discord)

Optional Worker secrets (see `packages/worker/src/app/oauth-providers.ts` and
[`social-login.md`](./social-login.md)):

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `X_CLIENT_ID` / `X_CLIENT_SECRET`
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_MEMBER_ROLE_ID` /
  `DISCORD_STANDARD_ROLE_ID` / `DISCORD_PRO_ROLE_ID` (optional; official Kody
  Discord guild join and role sync. Bot token + guild id enable Add Guild Member
  during Discord social login; at least one role id enables role writes. The bot
  needs Create Instant Invite and Manage Roles. Standard/Pro follow
  `orgs.stripe_plan`.)

A provider's login button only renders when both of its values are set. A
`MOCK_`-prefixed client id activates the in-worker mock provider flow on
non-production runtimes (used by local dev and E2E tests). In GitHub Actions the
values live under `OAUTH_`-prefixed secret names because Actions reserves
`GITHUB_*`; the deploy workflow maps them to the unprefixed Worker secrets.

## Kit subscriber tags

Optional Worker secrets / vars for exist-only Kit tagging on account events:

- `KIT_API_KEY` — Kit v4 API key (`X-Kit-Api-Key`). Preview deploys omit the key
  so they never write to the production Kit audience.
- `KIT_SIGNED_UP_TAG_ID` — optional override for the Kit tag applied on account
  signup when the email already exists in Kit (defaults to `signed_up::kody`).
  Account events never create Kit subscribers and never fail when Kit is unset.
  When a subscriber already exists, lifecycle tags are added in place
  (`signed_up::kody`, `verified::kody`, `agent_connected::kody`,
  `activated::kody`, plus `standard::kody` / `pro::kody` from Stripe). Paid tags
  are removed on cancel. The hourly `kit_subscriber_sync` lane reconciles the
  same exist-only tags.

See [`architecture/authentication.md`](./architecture/authentication.md).

## Stripe billing

Optional Worker secret and vars for account subscription billing
(`packages/worker/src/billing/`, routes under `/@<slug>/-/billing`). When
`STRIPE_SECRET_KEY` is unset, billing is disabled: the account billing page
shows plan info plus a "not configured" notice, and success/portal/cron skip
safely. Manual `orgs.plan` grants apply regardless.

- `STRIPE_SECRET_KEY` — Stripe secret API key. Required for checkout linking,
  portal sessions, and `stripe_plan` refresh. Synced as a Worker secret from the
  GitHub Actions secret of the same name on production deploy when set.
- `STRIPE_WEBHOOK_SECRET` — Stripe endpoint signing secret (`whsec_...`) for
  `POST /webhooks/stripe`. When unset, the webhook endpoint returns 503. Synced
  as a Worker secret from the GitHub Actions secret of the same name on
  production deploy when set.
- `STRIPE_API_BASE_URL` — optional API base URL; defaults to
  `https://api.stripe.com` when unset. Override for tests/mocks.
- `STRIPE_PRO_PRICE_ID` — Stripe Price id for the purchasable $12/month Pro
  (`price_1UKHxZLAQpAnsYszwwqZTCCT` on `prod_VKxtLxMdjEkOdu` in production), the
  only self-serve paid plan and the only Stripe price that grants the prepaid
  credit wallet (`orgs.stripe_credits_eligible`). Reusing a retired Standard or
  Pro id here would make those subscribers wallet-eligible.
- `STRIPE_PRO_YEARLY_PRICE_ID` — Stripe Price id for the purchasable $120/year
  Pro (`price_1UKHxaLAQpAnsYszlsVHHXjK`).
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` — optional Stripe Billing Portal
  configuration id (`bpc_...`) passed as `configuration` when creating portal
  sessions for Manage subscription and for plan changes by existing subscribers.
  The production configuration enables `subscription_update` with
  `proration_behavior=always_invoice`, cancel at period end, payment method and
  customer updates, and invoice history; its product list should offer only the
  purchasable Pro. Switching to Pro from Kody uses the
  `subscription_update_confirm` flow pinned to the Pro price. When unset
  (preview, test, local), Stripe uses the account's default portal
  configuration.

Each price id independently enables authenticated Checkout and subscription
matching for its tier and interval; leaving a monthly or yearly id unset makes
only that interval unavailable for purchase. Price ids and the portal
configuration id are public (non-secret) values committed as production Wrangler
vars in `packages/worker/wrangler.jsonc`, not Worker secrets. The retired
Standard ($12/$120, $5) and Pro ($49/$480 and earlier) price ids remain in
`retiredStandardPriceIds` / `retiredProPriceIds` in
`packages/worker/src/billing/billing-config.ts` so existing subscribers keep
their plan (no mass migration). Retired prices are never wallet-eligible; delete
each id once no subscriber remains on it.

Dashboard-side dunning (not an environment variable, recorded here so it
survives re-provisioning): the production Stripe account has every customer
email under Settings → Billing → Subscriptions and emails → "Email notifications
and customer management" enabled (trial-ending reminder, upcoming renewals,
expiring cards, failed card payments, failed bank-debit payments), and "Manage
failed payments" cancels the subscription when all retries fail. Kody also sends
its own past-due and payment-failed emails (`billing/subscription-sync.ts`,
`billing/stripe-webhooks.ts`), deduplicated so one failed charge is not two Kody
emails; the Stripe email is additive and carries the card-update link.

See [`architecture/entitlements.md`](./architecture/entitlements.md) (Billing).

## MCP OIDC ID token signing

Required Worker configuration for MCP OAuth OpenID Connect ID tokens (RS256):

- `OIDC_SIGNING_KEY_ID` — JWT header `kid` (non-empty string). Production should
  use a deployment-specific value (for example `kody-oidc-2026-09`).
- `OIDC_SIGNING_PRIVATE_KEY_PEM` — PKCS#8 RSA private key PEM. Generate with
  `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc.pem`.
  Local dev and tests use the committed example key in
  `packages/worker/.env.example`. **Production must use a dedicated key** synced
  as a Worker secret (not a Wrangler `var`).

Public JWKS is derived from the private key at `/.well-known/jwks.json`.

## Saved-secret encryption (`SECRET_STORE_KEY`)

Required Worker secret used to derive the AES-GCM key for encrypting saved
secrets at rest in D1.

- **Every environment must set `SECRET_STORE_KEY`**, including local dev and CI,
  so saved secrets can be encrypted and decrypted.
- See [`docs/contributing/secret-rotation.md`](./secret-rotation.md) for
  rotation procedures.

## MCP capability search (Vectorize + Workers AI)

Worker bindings (see `packages/worker/wrangler.jsonc`):

- **`CAPABILITY_VECTOR_INDEX`** — Cloudflare Vectorize index for semantic
  retrieval (`kody-capabilities-prod`; each preview gets its own
  `<preview-worker-name>-vectors` from `tools/ci/preview-resources.ts`). Create
  indexes with **`--dimensions=384 --metric=cosine`** to match
  `@cf/baai/bge-small-en-v1.5` with `cls` pooling (see
  `packages/worker/src/vectorize/embedding.ts`). The **`test`** Wrangler
  environment omits this binding so `npm run test` and e2e use the deterministic
  offline fusion path (`offline: true` in search results).
- **`AI`** — Workers AI binding used by production and preview capability,
  memory, job, and saved-package embedding calls, and by ranked MCP search Jev
  Score (`typesafe/jev`) when `jev-search-rerank` is on. Local dev and tests do
  not require it because `WRANGLER_IS_LOCAL_DEV`, `SENTRY_ENVIRONMENT=test`, or
  a missing non-production binding keeps search on the deterministic offline
  path.

Worker secrets:

- **`AI_GATEWAY_ID`** — Cloudflare AI Gateway id. When set, embedding and Jev
  Score calls use the Workers AI binding `gateway` option so production and
  preview inference is logged/routed through AI Gateway. When unset, embeddings
  call Workers AI directly; `typesafe/jev` does not (that third-party model
  requires AI Gateway plus Unified Billing or BYOK). The configured gateway must
  have authentication enabled and a non-zero Unified Billing balance, or a BYOK
  key; authentication off yields HTTP 403, zero credits yields HTTP 402.
- **`CAPABILITY_REINDEX_SECRET`** — strongly recommended for production (CI
  skips the post-deploy capability reindex and origin-only execute smoke check
  when it is unset); bearer token for `POST /__maintenance/reindex-capabilities`
  and other secret-gated maintenance endpoints. Production deploy POSTs
  `{ "phases": ["capabilities"] }` so only builtin capability vectors refresh
  after a ship. User-owned memory, job, and saved-package vectors upsert on
  write. Omit `phases` (or list every kind) after changing the embedding model,
  pooling, or Vectorize index dimensions to rebuild those rows too, with
  per-user `userId` metadata on user-owned rows. Unchanged embed text and
  Vectorize metadata skip embed and Vectorize upsert; after Vectorize data loss
  or a pooling-only change, POST `{ "force": true }` (and omit `phases` for
  every kind) so matching fingerprints cannot skip upserts. Each call is
  time-budgeted and may return `complete: false` plus a `cursor` to resume.
  Local dev uses offline search while `WRANGLER_IS_LOCAL_DEV` is set or the
  binding is missing.
- **`JOB_REINDEX_SECRET`** — optional Worker secret; bearer token for
  `POST /__maintenance/reindex-jobs` when you want a jobs-only Vectorize rebuild
  (without a full capability/memory/package reindex). When unset, the jobs-only
  endpoint returns not-configured. Production deploys do not refresh job
  vectors; those upsert on write. Use this secret or a full capability reindex
  when you need a jobs rebuild. After Vectorize data loss, use
  `POST /__maintenance/reindex-capabilities` with `{ "force": true }` rather
  than the jobs-only endpoint so restored D1 fingerprints cannot skip an empty
  index.
- **`STATUS_INCIDENT_EVENT_SECRET`** — optional Worker secret shared with the
  status worker. Bearer token for origin `POST /__maintenance/status-incidents`,
  which fans `status.incident.opened` / `status.incident.resolved` to admin
  package subscriptions, and for status
  `POST /__maintenance/incidents/:id/retrospective`, which attaches a public
  writeup to a resolved probe-derived incident, and status
  `DELETE /__maintenance/incidents/:id`, which removes a resolved
  health-check-only incident. When unset, the origin endpoint returns
  not-configured, the status worker skips emit, and both incident maintenance
  routes return 503; packages can reconcile open/resolve from public
  `/status.json`. Synced from the GitHub Actions secret of the same name on
  production deploy.

## Cloudflare API (Worker + Email)

Optional Worker secrets/vars (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/mcp/cloudflare/cloudflare-rest-client.ts`):

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token used by the internal API client
  (`Authorization: Bearer ...`) for Worker-side Cloudflare REST calls such as
  the Cloudflare Email sender. User Cloudflare API calls from authored package
  modules use saved secrets and secret-aware `fetch` (see
  `docs/contributing/packages-and-manifests.md`). Local `npm run dev` sets this
  to the Cloudflare mock token unless `SKIP_CLOUDFLARE_MOCK=1`. Production
  workers never receive the deploy token and do not share one value:
  `kody-production` and `kody-platform` receive `CLOUDFLARE_APP_API_TOKEN`,
  `kody-runtime` receives `CLOUDFLARE_RUNTIME_API_TOKEN` (Email Sending +
  Artifacts only), and `kody-status` receives `CLOUDFLARE_STATUS_API_TOKEN`
  (Email Sending only), each via a required
  `--set-from-env CLOUDFLARE_API_TOKEN=<GitHub secret>` alias in
  `.github/workflows/deploy.yml`. See `docs/contributing/setup-manifest.md` for
  the permission lists.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id required by the Cloudflare
  Email Service REST API fallback used by local mocks and preview deploys. This
  is a Worker var (not a secret) and should match the account behind
  `CLOUDFLARE_API_TOKEN`. When `CLOUDFLARE_API_BASE_URL` points at the in-repo
  Cloudflare mock, the account id is a path segment for mock state partitioning;
  the mock accepts the caller's authenticated account id (preview keeps the real
  account id).
- `CLOUDFLARE_API_BASE_URL` — API base URL; defaults to
  `https://api.cloudflare.com` when unset, including for outbound email sending.
  Local `npm run dev` sets this to the Cloudflare mock Worker unless
  `SKIP_CLOUDFLARE_MOCK=1`. That same local mock serves the Artifacts REST
  control-plane endpoints used by `packages/worker/src/repo/artifacts.ts`
  (`repos`, `tokens`, and `fork`), so local repo create/get/list/token/fork
  calls do not need the live Artifacts REST API.
- `CLOUDFLARE_API_SOURCE_SNAPSHOTS` — set to `true` only when
  `CLOUDFLARE_API_BASE_URL` points at a local Cloudflare API stand-in that can
  return a repo's whole tree at a commit (`npm run dev` and the MCP e2e harness
  set it alongside the mock). The real Cloudflare API has no such endpoint, so
  production leaves it unset and
  `packages/worker/src/repo/artifact-source-snapshot.ts` returns `null` without
  a request; published trees come from `BUNDLE_ARTIFACTS_KV` snapshots. PR
  previews also leave it unset and use per-PR `BUNDLE_ARTIFACTS_KV` the same
  way.
- `CLOUDFLARE_ARTIFACTS_API_TOKEN` — optional. When the Worker binds real
  `ARTIFACTS` but `CLOUDFLARE_API_BASE_URL` points at a mock (PR previews),
  Artifacts createToken/fork REST uses this token against
  `https://api.cloudflare.com` instead of the mock. Preview deploy syncs the
  real deploy token here while `CLOUDFLARE_API_TOKEN` stays the mock credential
  for email. Production leaves it unset and uses `CLOUDFLARE_API_TOKEN`.
- `USER_EMAIL_DOMAIN` — optional override for the user email domain (see
  `packages/worker/src/email/platform-address.ts`). Defaults to
  `inbox.<APP_BASE_URL hostname>` (for example `inbox.kody.codes`): every user
  inbox and user outbound sender lives at `{username}@<this domain>`. User mail
  deliberately lives on a subdomain so the user-controlled namespace and its
  sender reputation stay separate from system transactional mail
  (`kody@<apex>`). The deployment's Cloudflare zone needs Email Routing enabled
  for this subdomain (Email > Email Routing > Settings > Add subdomain) with its
  catch-all routed to the Worker. Production commits
  `USER_EMAIL_DOMAIN=inbox.kody.codes` in `packages/worker/wrangler.jsonc` so
  the domain can never silently rederive from `APP_BASE_URL`; the deploy tooling
  (`tools/ci/production-resources.ts`) reads the same committed pin when
  configuring the user-inbox Email Sending event subscription
  (`kody-email-delivery-events`).
- `SYSTEM_EMAIL_DOMAIN` — optional override for the system email domain (the
  `kody@<domain>` transactional sender and operator system inboxes). Defaults to
  the `APP_BASE_URL` hostname. Production commits
  `SYSTEM_EMAIL_DOMAIN=kody.codes`. Signup, email-change, and password-reset
  messages also put this host on their action and asset links. Local
  `npm run dev` keeps those links on the request origin so they stay clickable.
  Deploy tooling reconciles a second `email.sending` subscription for this
  domain (`kody-system-email-delivery-events`) when it differs from
  `USER_EMAIL_DOMAIN`, so verification delivery status can advance past
  `accepted`.
- `LEGACY_USER_EMAIL_DOMAINS` / `LEGACY_SYSTEM_EMAIL_DOMAINS` — optional
  comma-separated additional email domains that inbound mail is accepted on
  alongside the canonical domains (see
  `packages/worker/src/email/platform-address.ts`). Delivery resolves to the
  same inboxes; outbound always sends from the canonical domains. Production
  leaves these unset.
- `ARTIFACTS_NAMESPACE` — Cloudflare Artifacts namespace for repo REST calls and
  for choosing the env-scoped `ARTIFACTS` binding. Defaults to `default` when
  unset (local dev and tests). Wrangler sets `production` for production.
  Preview ensure rewrites the generated configs to the per-PR worker name
  (`kody-pr-<n>` / `kody-branch-<slug>`) so each preview has an isolated
  Artifacts namespace. Production/preview also bind `ARTIFACTS` (JSRPC);
  create/get prefer that binding and fall back to REST. New repo sessions
  persist this value in D1 as `session_repo_namespace` so follow-up lookups
  resolve the correct namespace even after env changes.

## Disaster recovery (production Worker)

Optional production-only vars/secrets for the nightly non-D1 staging exporter
and chunked restore endpoint (`packages/worker/src/dr/`). All are inert until
`DR_EXPORT_ENABLED` is the literal string `"true"` and S3 credentials are set.
See [Disaster recovery](./disaster-recovery.md).

- `DR_EXPORT_ENABLED` — Worker var; enable staging only when `"true"`.
- `DR_BACKUP_ACCOUNT_ID` / `DR_BACKUP_BUCKET_NAME` — DR account id and backup
  bucket name (S3 API endpoint host uses the account id).
- `DR_BACKUP_ACCESS_KEY_ID` / `DR_BACKUP_SECRET_ACCESS_KEY` — Worker secrets; R2
  S3 credentials that can write `staging/` and `blobs/` in the DR bucket.
- `BACKUP_MANIFEST_SIGNING_KEY_ID` /
  `BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64` — public verification
  material shared with the DR control plane. The Mailbox importer fails closed
  when either differs from the signed full manifest.
- `DR_RESTORE_SECRET` — Worker secret; bearer token for
  `POST /__maintenance/dr-restore`, `POST /__maintenance/dr-mailbox-import`, and
  the operator-only `POST /__maintenance/do-pitr`. Must match the control-plane
  secret of the same name. Fail-closed when unset.

## Backup control plane (DR account Worker)

Lives under `packages/backup-control-plane/` in the DR Cloudflare account. Code
deploys via the production GitHub Actions workflow when control-plane / shared
backup contract or backup-resource paths change. GitHub Actions requires
`DR_DEPLOY_TOKEN` and `DR_BACKUP_ACCOUNT_ID`. An optional
`DR_BACKUP_ADMIN_TOKEN` with DR-account Workers R2 Storage Write reconciles and
reads back the lock/lifecycle policy before the Worker deploy. When unavailable,
Actions logs a reconciliation skip and deploys normally. The admin token is
never installed as a Worker secret. Enable gates and source identity vars live
in that package's `wrangler.jsonc`.

Workflow bindings are `BACKUP_WORKFLOW`, `RESTORE_WORKFLOW`, and
`SEAL_WORKFLOW`.

Non-secret vars:

- `ENABLE_PRODUCTION_D1_BACKUPS` / `BACKUP_BENCHMARK_APPROVED` — both must be
  exactly `"true"` or schedules stay inert.
- `SOURCE_ACCOUNT_ID` / `SOURCE_DATABASE_ID` / `SOURCE_DATABASE_NAME` plus
  `SOURCE_DATABASES` (JSON array of `{ id, name }` objects; the nightly path
  exports every entry) and `ALLOWED_SOURCE_ACCOUNT_IDS` /
  `ALLOWED_SOURCE_DATABASE_IDS`. `SOURCE_DATABASE_ID` / `SOURCE_DATABASE_NAME`
  are the primary APP_DB (`kody`) identity and the single-database fallback when
  `SOURCE_DATABASES` is unset. Every listed id must appear in
  `ALLOWED_SOURCE_DATABASE_IDS`. Production `kody-jobs` UUID is the live D1
  named `kody-jobs`; deploy resolves it by name in
  `tools/ci/jobs-worker-resources.ts` (`jobs_d1_database_id`).
- `BACKUP_MANIFEST_SIGNING_KEY_ID`,
  `BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64`,
  `TRUSTED_RESTORE_BASELINE_ID`, `TRUSTED_RESTORE_BASELINE_SHA256`.
- `BACKUP_MAX_AGE_HOURS` (default 26), `BACKUP_MAX_SOURCE_BYTES` (≤ 4.5e9).
- `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`, `ACCESS_ALLOWED_EMAIL` — Zero Trust
  Access JWT verification (policy pinned to the solo operator email).
- `DRILL_ACCOUNT_ID` — isolated account for UI restore drills (must differ from
  source).
- `PRIMARY_WORKER_ORIGIN` — production Worker origin for
  `/__maintenance/dr-restore`.

Secrets (Wrangler secret storage only — never `.env`, config, logs, or
evidence):

- `CLOUDFLARE_API_TOKEN` — production-account Account D1 Edit (export +
  production import).
- `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64` — base64 Ed25519 PKCS#8.
- `DRILL_API_TOKEN` — drill-account D1 Edit for isolated UI drills.
- `RESTORE_CONFIRM_SECRET` — HMAC secret for the 10-minute prepare→execute
  production-restore token.
- `DR_RESTORE_SECRET` — bearer shared with the production Worker.
- `DR_OPS_SECRET` — optional bearer for agent-only seal enqueue/status on
  `POST /__maintenance/dr-seal` and `GET /__maintenance/seal-status` on the DR
  control plane. Does not grant restore, drill, or purge. Unset → `503` on those
  routes. Edge Access on `kody-dr.kentcdodds.com` is still required unless a
  service token or `/__maintenance/*` bypass is configured (see
  disaster-recovery runbook).

GitHub Actions `workflow_dispatch` escrow (`.github/workflows/dr-escrow.yml`)
also needs `SECRET_STORE_KEY`, `SECRET_ESCROW_PASSPHRASE`, and the DR S3
credentials (`DR_BACKUP_*`) as repository secrets.

## Why a schema?

The `remix/data-schema` env schema gives type inference for `Env`-driven values
and a single runtime gate that fails fast with clear errors. It keeps the
“what’s required” definition in one place.
