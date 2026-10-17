# Operator accounts

Inventory of third-party services Kody or its CI depends on: what each owns,
which secret and variable **names** it uses, where it is configured, and how to
recover access. Secret **values** do not belong here.

Kent is the solo operator. This page is the bus-factor map. Resource shape and
local/fork setup live in [setup-manifest.md](./setup-manifest.md). Per-variable
semantics live in [environment-variables.md](./environment-variables.md). Crypto
key rotation lives in [secret-rotation.md](./secret-rotation.md). Production
data recovery lives in [disaster-recovery.md](./disaster-recovery.md).

Dashboard-only facts the repo cannot name (registrar, account logins, vault item
names, dashboard object ids) live in the operator password manager, never here.
Lines marked `Password manager:` say what is recorded there; see
[Password manager coverage](#password-manager-coverage).

## Cloudflare

Production compute, DNS, email, storage, and the DR destination. Two
independently administered accounts (ids are committed):

| Account                          | Id                                 | Role                                                                                                                                                          |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kody (production)                | `a99ee2e72728dd52902ef288b7b1447d` | Product Workers, D1, KV, R2, Queues, Vectorize, Analytics Engine, Artifacts, Images, Workers AI, Email, zones                                                 |
| KCD (DR; old pre-migration prod) | `a41d50ecaf0ae0f86dd1824ef6729cb2` | Backup control plane, locked R2 `kody-production-backups`, Access-protected Admin UI at `kody-dr.kentcdodds.com`. Personal journaling leftovers stay here too |

Dashboard: [Cloudflare dashboard](https://dash.cloudflare.com/) → the account
above. Account-level API tokens: **Manage Account → Account API Tokens**.

### Zones

| Zone             | Account    | Role                                                                                                      |
| ---------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `kody.codes`     | production | App origin, `status.kody.codes`, `nx-cache.kody.codes`, `inbox.kody.codes`, system mail `kody@kody.codes` |
| `kody.run`       | production | Hosted package apps (`{username}.kody.run`). Zone routes only — not a Workers custom domain               |
| `kentcdodds.com` | KCD / DR   | `kody-dr.kentcdodds.com` custom domain on the backup control-plane Worker                                 |

Retired brand hosts (`heykody.app`, `heykody.dev`, `kodyapps.dev`,
`status.heykody.dev`) stay retired
([0044](./decisions/0044-retired-brand-domains-stay-retired.md)). They may still
answer as Cloudflare-level redirects. Registrar ownership is not in the repo.

`Password manager: registrar for kody.codes, kody.run, and the retired heykody.* / kodyapps.dev zones.`

### Workers fleet

| Script                       | Public surface                         | Config                                                                 |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `kody-production`            | `https://kody.codes`                   | `packages/worker/wrangler.jsonc` (deploy `--name kody-production`)     |
| `kody-platform`              | `/__platform/health` only              | `packages/platform-worker/wrangler.jsonc`                              |
| `kody-runtime`               | `{user}.kody.run`; `/__runtime/health` | `packages/runtime-worker/wrangler.jsonc`                               |
| `kody-jobs`                  | none (workers.dev health only)         | `packages/jobs-worker/wrangler.jsonc`                                  |
| `kody-highlight`             | none                                   | `packages/highlight-worker/wrangler.jsonc`                             |
| `kody-status`                | `https://status.kody.codes`            | `packages/status/wrangler.jsonc`                                       |
| `kody-nx-cache`              | `https://nx-cache.kody.codes`          | `packages/nx-cache/wrangler.jsonc`                                     |
| `kody-production-d1-backups` | `https://kody-dr.kentcdodds.com`       | `packages/backup-control-plane/wrangler.jsonc` (DR account)            |
| `kody-domain-redirect`       | `www.kody.codes`, `www.kody.run`       | Mentioned in [setup-manifest.md](./setup-manifest.md); apex `www` 301s |

Fleet table and request path:
[architecture/index.md](./architecture/index.md#production-worker-fleet).

### D1

| Name         | Binding / role             | Production UUID (committed on the DR control plane) |
| ------------ | -------------------------- | --------------------------------------------------- |
| `kody`       | `APP_DB`                   | `8c1014d1-6b41-4695-a0a2-159071f0f919`              |
| `kody-audit` | `AUDIT_DB`                 | not committed                                       |
| `kody-jobs`  | `JOBS_DB`                  | `5410331e-4d25-47e4-a1e5-a248f7cc764c`              |
| `kody-pr-*`  | per-preview app/audit/jobs | created by `tools/ci/preview-resources.ts`          |

Dashboard: **Workers & Pages → D1**. Remote `database_id` values are written
into generated Wrangler configs at deploy, not into the committed
`wrangler.jsonc`.

### KV, R2, Queues, Vectorize, Analytics Engine, Artifacts, Images, AI

Production names from committed Wrangler / ensure scripts
([setup-manifest.md](./setup-manifest.md)):

- **KV** — `OAUTH_KV` title `kody-oauth`; `BUNDLE_ARTIFACTS_KV` title
  `kody-bundle-artifacts`. Preview titles are per-PR.
- **R2** — `kody-community-assets`, `kody-email-blobs`,
  `kody-repo-session-blobs`, `kody-nx-cache`. DR: `kody-production-backups`.
  Preview uses `kody-preview-*` prefixes.
- **Queues** (each has a matching `-dlq`) — `kody-email-delivery`,
  `kody-artifacts-repo-events`, `kody-platform-feedback-dispatch`,
  `kody-community-activity-dispatch`,
  `kody-community-listing-published-dispatch`, `kody-package-events-dispatch`,
  `kody-scheduled-dispatch`, `kody-webhook-dispatch`.
- **Vectorize** — `kody-capabilities-prod` (384 dimensions, cosine,
  `@cf/baai/bge-small-en-v1.5`). Previews use per-preview
  `<preview-worker-name>-vectors` indexes.
- **Analytics Engine** — `kody_usage_events`, `kody_flag_exposures`,
  `kody_email_events`, `kody_mcp_protocol_events`,
  `kody_execute_interpretable_events`, `kody_mcp_search_events`.
- **Artifacts** — namespaces `production` and `preview`; binding `ARTIFACTS`.
- **Images** — binding `IMAGES` on origin and platform (no extra resource to
  create).
- **Workers AI** — binding `AI`. Optional AI Gateway id (`AI_GATEWAY_ID` /
  `AI_GATEWAY_ID_PREVIEW`). Ranked-search Jev Score (`typesafe/jev`) requires
  that gateway: authentication enabled and Unified Billing credits (or BYOK).
  Auth off is HTTP 403; zero credits is HTTP 402. Embeddings (`@cf/baai/…`)
  succeed without Gateway.
- **OTLP traces** — account destination `sentry-otlp-traces` → Sentry project
  `kody-cloudflare`. Dashboard: **Workers Observability → Destinations**.

### Email (Cloudflare Email Sending + Email Routing)

User inboxes: `{username}@inbox.kody.codes`. System / transactional:
`kody@kody.codes`. Status alerts: `kody@kody.codes` → `me@kentcdodds.com`.

Dashboard on the `kody.codes` zone: **Email → Email Routing** (MX, subdomain
`inbox`, catch-all to the origin Worker) and **Email → Email Sending** (domain
verification, `email.sending` event subscriptions on `kody-email-delivery` for
both `inbox.kody.codes` and `kody.codes`).

Binding: `EMAIL` (`send_email`). REST fallback uses `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`. Committed pins: `USER_EMAIL_DOMAIN=inbox.kody.codes`,
`SYSTEM_EMAIL_DOMAIN=kody.codes` in `packages/worker/wrangler.jsonc`. Production
deploy ensures two Queue event subscriptions when those domains differ:
`kody-email-delivery-events` (user inbox) and
`kody-system-email-delivery-events` (transactional `kody@`).

DMARC reporting: production ensure upserts `_dmarc.kody.codes` and
`_dmarc.inbox.kody.codes` to `v=DMARC1; p=reject; rua=mailto:dmarc@kody.codes`,
and an Email Routing rule that forwards `dmarc@kody.codes` to
`me@kentcdodds.com` (override with Actions env `DMARC_REPORT_FORWARD_TO`). The
forward destination must already be verified under **Email → Email Routing →
Destination addresses** — Cloudflare's verification email is Kent-only and is
not skippable via API. Deploy token needs DNS Edit plus Email Routing edit on
the mail zone.

### Access (Zero Trust)

DR Admin UI (`kody-dr.kentcdodds.com`) is gated by Cloudflare Access plus
in-worker `Cf-Access-Jwt-Assertion` checks. Committed control-plane vars:

- `ACCESS_TEAM_DOMAIN` = `kentcdodds.cloudflareaccess.com`
- `ACCESS_APP_AUD` =
  `769c70e393e2652f5878af99333322184a35cc3aef53376344f8753805e42a76`
- `ACCESS_ALLOWED_EMAIL` = `me@kentcdodds.com`

Dashboard: **Zero Trust → Access → Applications**. Policy is pinned to that
email.

### Turnstile

Required in production for public signup. Both `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` must be set; production boot fails without them, and
request handlers refuse with a `503` (to Sentry) if either key disappears. Local
(`WRANGLER_IS_LOCAL_DEV`), preview, and test may omit them even when generated
local wrangler still sets `SENTRY_ENVIRONMENT=production`. Dashboard:
**Turnstile**. `.github/workflows/deploy.yml` does not sync these secrets.

### API tokens

Every Worker reads its Cloudflare REST token as the Worker secret
`CLOUDFLARE_API_TOKEN`, but production uploads a different least-privilege
GitHub secret to each Worker
([#2010](https://github.com/kody-hq/kody/issues/2010)). The deploy token is
never uploaded to a Worker, and `.github/workflows/deploy.yml` runs a shared
`require-worker-tokens` job before any production mutation when a Worker-scoped
token is unset or equals the deploy token, or when the deploy token itself is
unset (`tools/ci/check-worker-cloudflare-tokens.ts`).

| Name (GitHub Actions unless noted)   | Holder                                                                             | Purpose                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`               | Actions only (wrangler + `tools/ci`)                                               | Deploy and resource ensure. Never a Worker secret                                    |
| `CLOUDFLARE_APP_API_TOKEN`           | Actions → `kody-production` + `kody-platform` Worker secret `CLOUDFLARE_API_TOKEN` | Email Sending Edit, Artifacts Edit, Account Analytics Read, Queues Edit (required)   |
| `CLOUDFLARE_RUNTIME_API_TOKEN`       | Actions → `kody-runtime` Worker secret `CLOUDFLARE_API_TOKEN`                      | Email Sending Edit + Artifacts Edit (required)                                       |
| `CLOUDFLARE_STATUS_API_TOKEN`        | Actions → `kody-status` Worker secret `CLOUDFLARE_API_TOKEN`                       | Email Sending Edit for operator alert email (required)                               |
| `CLOUDFLARE_ACCOUNT_ID`              | Actions **variable** + Worker var                                                  | Account id for REST / ensure                                                         |
| `CLOUDFLARE_ZONE_ID`                 | Actions **variable**                                                               | Zone that owns the user-email sending domain                                         |
| `DR_DEPLOY_TOKEN`                    | Actions                                                                            | Deploy `kody-production-d1-backups` in the DR account                                |
| `DR_BACKUP_ADMIN_TOKEN`              | Actions (never a Worker secret)                                                    | Reconcile DR R2 lock/lifecycle                                                       |
| `DRILL_API_TOKEN`                    | DR Worker secret                                                                   | Isolated drill-account D1                                                            |
| Control-plane `CLOUDFLARE_API_TOKEN` | DR Worker secret                                                                   | Production-account D1 Edit (export + import). Separate from the Actions deploy token |

`AI_GATEWAY_ID` / `AI_GATEWAY_ID_PREVIEW` are optional Worker secrets (Gateway
id, not a Cloudflare API token). For `typesafe/jev`, the configured gateway must
have authentication enabled and Unified Billing credits (or BYOK).

### Other Cloudflare-owned Worker / Actions names

`COOKIE_SECRET`, `SECRET_STORE_KEY`, `OIDC_SIGNING_PRIVATE_KEY_PEM`,
`OIDC_SIGNING_KEY_ID`, `CAPABILITY_REINDEX_SECRET`, `JOB_REINDEX_SECRET`,
`STATUS_INCIDENT_EVENT_SECRET`, `DR_EXPORT_ENABLED`, `DR_BACKUP_ACCOUNT_ID`,
`DR_BACKUP_BUCKET_NAME`, `DR_BACKUP_ACCESS_KEY_ID`,
`DR_BACKUP_SECRET_ACCESS_KEY`, `DR_RESTORE_SECRET`, `SECRET_ESCROW_PASSPHRASE`,
`BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, `RESTORE_CONFIRM_SECRET`,
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` /
`NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN` (Worker names `CACHE_ACCESS_TOKEN` /
`CACHE_READ_TOKEN`).

Rotation: [secret-rotation.md](./secret-rotation.md) for `COOKIE_SECRET`
([rotating COOKIE_SECRET](./secret-rotation.md#rotating-cookie_secret)),
`SECRET_STORE_KEY`
([rotating SECRET_STORE_KEY](./secret-rotation.md#rotating-secret_store_key),
[escrow](./secret-rotation.md#escrow)), and OIDC
([key inventory](./secret-rotation.md#key-inventory)). Mint new API tokens in
the dashboard, then replace the GitHub secret and re-deploy so
`sync-worker-secrets` / `wrangler secret put` pick up the new value. Do not
revoke the old token until `/health` on every script and a signup-verification
email succeed.

Recovery: Cloudflare account login (email + 2FA) is the root. Tokens can be
re-minted. D1 Time Travel and the DR control plane are the data escape hatches
([disaster-recovery.md](./disaster-recovery.md), [rollback.md](./rollback.md)).
Losing the Cloudflare account login without a second admin is unrecoverable for
live traffic.

## GitHub

Source of truth for this repository, Actions, preview environments, CLA signers,
and MCP Registry publish (OIDC). Repo:
[kody-hq/kody](https://github.com/kody-hq/kody).

Dashboard: repo **Settings → Secrets and variables → Actions**.

### Actions secrets (names)

From `.github/workflows/*.yml` (automatic `GITHUB_TOKEN` omitted):

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_APP_API_TOKEN`,
`CLOUDFLARE_RUNTIME_API_TOKEN`, `CLOUDFLARE_STATUS_API_TOKEN`, `COOKIE_SECRET`,
`SECRET_STORE_KEY`, `AI_GATEWAY_ID`, `AI_GATEWAY_ID_PREVIEW`, `SENTRY_DSN`,
`SENTRY_AUTH_TOKEN`, `CAPABILITY_REINDEX_SECRET`, `OAUTH_GITHUB_CLIENT_ID`,
`OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GOOGLE_CLIENT_ID`,
`OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_X_CLIENT_ID`, `OAUTH_X_CLIENT_SECRET`,
`OAUTH_DISCORD_CLIENT_ID`, `OAUTH_DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`DISCORD_GUILD_ID`, `DISCORD_MEMBER_ROLE_ID`, `DISCORD_STANDARD_ROLE_ID`,
`DISCORD_PRO_ROLE_ID`, `KIT_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STATUS_INCIDENT_EVENT_SECRET`,
`OIDC_SIGNING_PRIVATE_KEY_PEM`, `OIDC_SIGNING_KEY_ID`,
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`,
`NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN`, `KODY_WEBHOOK_URL_RUN`,
`SECRET_ESCROW_PASSPHRASE`, `DR_BACKUP_ACCOUNT_ID`, `DR_BACKUP_BUCKET_NAME`,
`DR_BACKUP_ACCESS_KEY_ID`, `DR_BACKUP_SECRET_ACCESS_KEY`, `DR_DEPLOY_TOKEN`,
`DR_BACKUP_ADMIN_TOKEN`, `PREVIEW_ENVIRONMENT_ADMIN_TOKEN`.

`DR_RESTORE_SECRET` and `JOB_REINDEX_SECRET` are documented as Worker / DR
secrets in [setup-manifest.md](./setup-manifest.md) and
[environment-variables.md](./environment-variables.md). They are not referenced
in the committed workflow YAML; set them on the Workers (and as an Actions
secret if a later workflow needs them).

### Actions variables (names)

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `APP_BASE_URL`,
`APP_LEGACY_HOSTS`, `APP_LEGACY_REDIRECT`, `PACKAGE_APP_LEGACY_HOSTS`,
`PACKAGE_APP_LEGACY_REDIRECT`, `USER_EMAIL_DOMAIN`, `SYSTEM_EMAIL_DOMAIN`,
`LEGACY_USER_EMAIL_DOMAINS`, `LEGACY_SYSTEM_EMAIL_DOMAINS`, `SENTRY_ORG`,
`SENTRY_PROJECT`.

### Apps and bots

| App / identity         | Used for                                                                                        | Config                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cursor Bugbot          | AI review on PRs (`Cursor Bugbot` check / `cursor[bot]` comments)                               | GitHub App on the repo; trigger via `kody:@kentcdodds/bugbot`                                                              |
| CodeRabbit             | Optional AI review comments                                                                     | GitHub App on the repo                                                                                                     |
| CLA workflow           | Records inbound CLA signers on `main` (`.github/workflows/cla.yml`, `.github/cla-signers.json`) | Not a GitHub App — `github-actions[bot]` commits to `main`                                                                 |
| `kody-bot`             | Allowlisted CLA identity; operator GitHub connector                                             | [inbound-contributions.md](./inbound-contributions.md)                                                                     |
| `cursoragent`          | Cursor Cloud Agent commit author; CLA-allowlisted                                               | same                                                                                                                       |
| Social-login OAuth App | `Sign in with GitHub` (`read:user user:email`)                                                  | [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers); see [social-login.md](./social-login.md) |

Actions secret names for social login are `OAUTH_GITHUB_*` because Actions
reserves `GITHUB_*`. Deploy maps them to Worker secrets `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`. Callback: `https://kody.codes/auth/github/callback`.

`PREVIEW_ENVIRONMENT_ADMIN_TOKEN` is a PAT (or equivalent) with repository
administration write, used by preview cleanup to delete leftover `preview-<pr>`
GitHub Environments on PR close. Preview deploys do not set a GitHub Actions
`environment:`; the token is there so cleanup can remove leftover and
race-recreated entries.

`KODY_WEBHOOK_URL_RUN` is the minted inbound webhook URL for
`@kentcdodds/weekly-site-perf` webhook `run`. Copy of the Kody user secret
`weeklySitePerfWebhookRun`. Not a Worker secret.

Operator GitHub packages (`kody:@kentcdodds/github`) authenticate through Kody
OAuth integrations, not secrets: `github-bot` (kody-bot, the default) and
`github-kent` (Kent's account, explicit request only) via
`createAuthenticatedFetch`. Tokens live encrypted on the integration row
(#2133); there is no password-manager item to keep. Recovery is
`/connect/oauth?provider=github-bot` signed in as the kody-bot GitHub user. The
guide-default `githubAccessToken` user secret in the how-Kody-works transcript
is a tutorial example, not an operator credential.

Rotation: replace the Actions secret, then re-run production deploy so Worker
secrets sync. OAuth App client secrets: **Developer Settings → OAuth Apps →
Generate a new client secret**, then update `OAUTH_GITHUB_CLIENT_SECRET`.
`COOKIE_SECRET` / `SECRET_STORE_KEY` / OIDC:
[secret-rotation.md](./secret-rotation.md).

Recovery: GitHub account login for `kentcdodds` plus org/repo admin. A second
GitHub owner is not configured in-repo. Losing the user account without a
recovery code blocks Actions secret edits and CLA recording.

`Password manager: GitHub OAuth App display name; entry for PREVIEW_ENVIRONMENT_ADMIN_TOKEN and the kody-bot GitHub user login.`

## Stripe

Account subscription billing. Checkout, Customer Portal, webhooks, dunning
emails, and account-deletion refunds.

Dashboard: [Stripe Dashboard](https://dashboard.stripe.com/) → **Developers →
API keys**, **Developers → Webhooks**, **Settings → Billing → Subscriptions and
emails**, **Product catalog**, **Settings → Billing → Customer portal**.

### Secrets and committed ids

| Name                                     | Kind                    | Notes                                                                                                            |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                      | Actions + Worker secret | Secret API key                                                                                                   |
| `STRIPE_WEBHOOK_SECRET`                  | Actions + Worker secret | Endpoint signing secret (`whsec_…`) for `POST /webhooks/stripe`                                                  |
| `STRIPE_API_BASE_URL`                    | optional Worker var     | Defaults to `https://api.stripe.com`                                                                             |
| `STRIPE_PRO_PRICE_ID`                    | committed Wrangler var  | `price_1UKHxZLAQpAnsYszwwqZTCCT` on `prod_VKxtLxMdjEkOdu` (“Kody Pro”, $12/month) with the prepaid credit wallet |
| `STRIPE_PRO_YEARLY_PRICE_ID`             | committed Wrangler var  | `price_1UKHxaLAQpAnsYszlsVHHXjK` ($120/year)                                                                     |
| `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` | committed Wrangler var  | `bpc_1UBzc8LAQpAnsYszyBkO2N3F`                                                                                   |

Retired live prices (still matched in
`packages/worker/src/billing/billing-config.ts`, never wallet-eligible; the
$49
Pro product `prod_V1ChgPPenrxsAX` is renamed “Kody Pro (legacy)”): Standard `price_1U3sg6LAQpAnsYszGeL2nc8O`
($12),
`price_1U3sg6LAQpAnsYszqq9abwIY`
($120/year),
`price_1Tv3W2LAQpAnsYszSr4PGBkE`
($5); Pro
`price_1UChg1LAQpAnsYszAYn6eGgt`
($49),
`price_1UChg2LAQpAnsYszKAFCR778` ($480/year),
`price_1U1AISLAQpAnsYszIQvRJNhl`, `price_1U3sg6LAQpAnsYszlVpEIFGx`,
`price_1U3sg7LAQpAnsYszpozAEFUi`. Delete an id (and its Stripe price) once no
subscriber remains on it.

Webhook URL: `https://kody.codes/webhooks/stripe`. Handled events in
`packages/worker/src/billing/stripe-webhooks.ts`:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
- `invoice.paid`

Unknown types are acknowledged after process+record.

Dashboard dunning ([#2140](https://github.com/kody-hq/kody/pull/2140) describes
the live settings): **Settings → Billing → Subscriptions and emails → Email
notifications and customer management** has every customer email enabled
(trial-ending, upcoming renewals, expiring cards, failed card payments, failed
bank-debit payments). **Manage failed payments** cancels the subscription when
all retries fail. Kody also sends its own past-due / payment-failed mail; the
Stripe mail is additive and carries the card-update link.

Portal configuration enables `subscription_update` with
`proration_behavior=always_invoice`. Its product list must offer only the
purchasable Pro prices; switching to Pro from Kody uses the
`subscription_update_confirm` flow pinned to the Pro price. Prepaid credit
top-ups are one-off Checkout Sessions (`mode=payment`, card saved for
off-session auto-refill); auto-refill charges are off-session PaymentIntents.
Neither needs a Stripe Price.

Rotation: roll the secret key and webhook signing secret in the Stripe
dashboard, update the two Actions secrets, deploy. Price / portal id changes are
committed Wrangler vars (same change as the Stripe catalog edit).

Recovery: Stripe account login. Customers and subscriptions live in Stripe;
`orgs.stripe_customer_id` / `orgs.stripe_plan` in D1 are a projection refreshed
by webhooks and `StripePlanRefresh`. Losing `STRIPE_WEBHOOK_SECRET` returns 503
from `/webhooks/stripe` until it is replaced.

`Password manager: Stripe webhook endpoint id; entry for STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET.`

## Sentry

Error reporting, error-only session replay, source maps, and production OTLP
traces.

Dashboard: [Sentry](https://sentry.io/). Project slug in docs and Wrangler
comments: `kody-cloudflare`. Org slug is a GitHub Actions variable
(`SENTRY_ORG`), not committed.

| Name                        | Kind                       | Purpose                                                                      |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `SENTRY_DSN`                | Actions + Worker secret    | Ingest URL. Also exposed to the browser via `kody:sentry` / `/sentry-tunnel` |
| `SENTRY_ENVIRONMENT`        | Wrangler var               | `production` / `preview` / `test`                                            |
| `SENTRY_TRACES_SAMPLE_RATE` | Wrangler var (JSON number) | Production `0` so SDK traces do not duplicate OTLP export                    |
| `SENTRY_AUTH_TOKEN`         | Actions secret             | `project:releases` / source-map upload (`npm run sentry:upload-sourcemaps`)  |
| `SENTRY_ORG`                | Actions variable           | Org slug                                                                     |
| `SENTRY_PROJECT`            | Actions variable           | Project slug                                                                 |

OTLP destination name in Cloudflare: `sentry-otlp-traces` (see
[Cloudflare](#cloudflare)). Release = `APP_COMMIT_SHA`.

[#1092](https://github.com/kody-hq/kody/issues/1092) item 1 asks for Sentry
alert rules (error-rate spike; cron-monitor on the DR staging watchdog) on a
channel independent of Cloudflare Email. Those rules are dashboard-only.

Rotation: rotate the DSN/key in Sentry, update `SENTRY_DSN` and
`SENTRY_AUTH_TOKEN`, deploy. The OTLP destination header must change with the
project DSN public key.

Recovery: Sentry org owner login. A missing DSN disables reporting; the app
stays up.

`Password manager: Sentry org slug; alert-rule destination (email / Discord webhook); entry for SENTRY_AUTH_TOKEN.`

## Fathom

Privacy-first pageviews on production SSR pages only.

Committed Wrangler var: `FATHOM_SITE_ID=WKKSDJGN`
(`packages/worker/wrangler.jsonc`). Unset in local, preview, and test. Script:
`https://cdn.usefathom.com/script.js` (`data-spa=auto`). CSP allowlist in
`packages/worker/src/app/security-headers.ts` (`script-src`, `img-src`, and
`connect-src`).

Dashboard: [app.usefathom.com](https://app.usefathom.com/). No secret. After
changing `APP_BASE_URL`, open Settings → Sites → **kody.codes** → Firewall →
Domains and put the live hostname (`kody.codes`) on the **Allow** list. A
leftover `heykody.app` / `heykody.dev` Allow list drops every `kody.codes`
pageview while still returning a 200 GIF. The collect GIF is not proof of
ingest. The API token cannot read or write firewall settings. First-party CSP
`connect-src` must also include `https://cdn.usefathom.com` for `sendBeacon`
duration and `trackEvent` (pageviews use the image beacon).

Recovery: Fathom account login. Losing the site id only drops analytics; the app
stays up.

`Password manager: Fathom account login entry.`

## Scarf

Company-level page analytics on production `kody.codes` public marketing and
docs only. Pixel id is committed in `packages/worker/client/scarf-analytics.ts`
(no Wrangler var). Preview, local, and other hosts never send. CSP allowlist in
`packages/worker/src/app/security-headers.ts` (`img-src` only).

Dashboard: the Kody organization pixel at [scarf.sh](https://scarf.sh/). No
secret in the Worker.

Recovery: Scarf account login. Losing the pixel id only drops company analytics;
the app stays up.

`Password manager: Scarf account login entry.`

## Kit

Exist-only lifecycle tags on account events. API: `https://api.kit.com/v4`
(`X-Kit-Api-Key`).

| Name                   | Kind                    | Purpose                                                                  |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `KIT_API_KEY`          | Actions + Worker secret | Production exist-only Kit writes. Preview omits this so E2E cannot write |
| `KIT_SIGNED_UP_TAG_ID` | optional Worker var     | Defaults to `signed_up::kody` id `21252175`                              |

Other lifecycle tag **names** (ids resolved in Kit, exist-only):
`verified::kody`, `agent_connected::kody`, `activated::kody`, `standard::kody`,
`pro::kody`. Hourly `kit_subscriber_sync` lane reconciles them. Paid tags are
removed on cancel. Account events never create subscribers.

Create keys at
[Kit developer settings](https://app.kit.com/account_settings/developer_settings).
The same value can be stored as the Kody user secret `kitApiKey`.

Rotation: mint a new Kit API key, update `KIT_API_KEY`, deploy. Account events
skip Kit while the key is unset.

Recovery: Kit account login (`hello@kentcdodds.com` is the documented sequence
sender). Subscriber list lives in Kit, not D1.

`Password manager: Kit account login entry.`

## Discord

Three operator surfaces, one vendor:

1. **Social-login OAuth app** (`identify email guilds.join`) — Worker secrets
   `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` from Actions `OAUTH_DISCORD_*`.
   Callback `https://kody.codes/auth/discord/callback`. Setup:
   [social-login.md](./social-login.md). Dashboard:
   [Discord Developer Portal](https://discord.com/developers/applications).
2. **Official guild join + plan roles** — Worker / Actions secrets
   `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_MEMBER_ROLE_ID`,
   `DISCORD_STANDARD_ROLE_ID`, `DISCORD_PRO_ROLE_ID`. Bot needs **Create Instant
   Invite** and **Manage Roles**, and its highest role must sit above the roles
   it assigns. Standard/Pro follow `orgs.stripe_plan`. Invite URL in product
   copy: `https://kcd.im/kody-discord`.
3. **Shipped-PR summaries** — `kody:@kentcdodds/discord/send-shipped-pr` (see
   [ship-pr](../../.agents/skills/ship-pr/SKILL.md)). That package uses its own
   Discord bot credential as a Kody package secret, not a Worker secret.

Do not reuse the social-login app for `/connect/oauth` user integrations
([guides/providers/discord.md](../guides/providers/discord.md)).

Rotation: reset the OAuth client secret and/or bot token in the Developer
Portal, update the Actions secrets, deploy. Guild/role snowflakes change only if
the guild or roles are recreated.

Recovery: Discord account that owns the application and the official guild.
Login and billing succeed when the bot secrets are unset; join/role writes and
shipped-PR posts skip.

`Password manager: Discord application name(s) for social login vs shipped-PR bot; guild name.`

## Google

Social-login OAuth client (`openid email profile`). Worker secrets
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from Actions `OAUTH_GOOGLE_*`.
Callback `https://kody.codes/auth/google/callback`.

Dashboard: [Google Cloud Console](https://console.cloud.google.com/) → **APIs &
Services → Credentials** (Web application client) and **OAuth consent screen**.
Setup: [social-login.md](./social-login.md).

Rotation: create a new client secret, update `OAUTH_GOOGLE_CLIENT_SECRET`,
deploy.

Recovery: Google account that owns the Cloud project. GitHub login succeeds when
Google is unset.

`Password manager: Google Cloud project name / OAuth client name.`

## X

Social-login OAuth 2.0 confidential client
(`tweet.read users.read users.email`). Worker secrets `X_CLIENT_ID` /
`X_CLIENT_SECRET` from Actions `OAUTH_X_*`. Callback
`https://kody.codes/auth/x/callback`. Enable **Request email from users**.

Dashboard: [X Developer Portal](https://developer.x.com/en/portal/dashboard).
Setup: [social-login.md](./social-login.md).

Rotation: regenerate the OAuth 2.0 client secret, update
`OAUTH_X_CLIENT_SECRET`, deploy.

Recovery: X developer account that owns the project/app. X often omits email;
those users connect from `/account` while already signed in.

`Password manager: X project / app name.`

## Cursor

Cloud Agents API used by operator packages (`kody:@kentcdodds/cursor`, including
`createAgent` / `createRun` and weekly site-perf). Not a Worker secret.

Dashboard: [Cursor](https://cursor.com/) → account API keys (`crsr_…`). Saved in
Kody as user secret `cursorApiKey` with host `api.cursor.com` (see
[guides/providers/origin.md](../guides/providers/origin.md); that key is **not**
an Origin App credential).

Bugbot is the Cursor GitHub App (see [GitHub](#github)). Cloud Agent VMs for
this repo are created through that Cursor account.

Rotation: mint a new Cursor API key, update the Kody secret `cursorApiKey` on
the packages that read it. No Actions secret.

Recovery: Cursor account login for Kent. Losing the key blocks agent spawn and
ship-pr Discord cost lookup; production Kody stays up.

`Password manager: entry for the Cursor API key / cursorApiKey.`

## MCP Registry

Publishes `server.json` to the public MCP Registry on `main` (and
`workflow_dispatch`) via `.github/workflows/publish-mcp-registry.yml`. Auth is
GitHub OIDC (`mcp-publisher login github-oidc`). No extra secret. The job looks
up the version first: a matching already-published payload is a successful
no-op, and metadata edits that reuse a published version fail with a bump
instruction. A late duplicate-version error re-fetches and succeeds only when
the published payload still matches. `npm run workflows:check` requires that
same version bump on PRs and main pushes (pre-push SHA), and that `description`
stays at most 100 characters.

Dashboard: [MCP Registry](https://github.com/modelcontextprotocol/registry).
Recovery: GitHub repo admin + OIDC trust on the registry side.

## Domain registrars

DNS for live product hosts is Cloudflare (nameservers on `kody.codes` and
`kody.run`). Who the **registrar** is — and who holds `heykody.app`,
`heykody.dev`, `kodyapps.dev`, and `kentcdodds.com` — is not in the repo.

`kody-dr.kentcdodds.com` is a hostname on `kentcdodds.com` (DR Access UI).

Recovery: registrar login plus Cloudflare zone access. A registrar lockout
without Cloudflare nameserver control still leaves DNS editable in Cloudflare
until the registration expires.

`Password manager: registrar name and account login for each registrable domain (kody.codes, kody.run, kentcdodds.com, retired heykody.* / kodyapps.dev).`

## Password manager and escrow

`SECRET_ESCROW_PASSPHRASE` lives in the personal password manager **and** as a
GitHub Actions secret. It unwraps `escrow/secret-store-key.v1.json` in the DR
bucket ([secret-rotation.md escrow](./secret-rotation.md#escrow),
[disaster-recovery.md](./disaster-recovery.md)).

`Password manager: vault / item names for SECRET_ESCROW_PASSPHRASE, SECRET_STORE_KEY, COOKIE_SECRET, OIDC private key, Cloudflare tokens, and the other secrets listed above.`

## Password manager coverage

Each of these is recorded in the operator password manager. Names only; no
values in this repo.

1. `Password manager: registrar for kody.codes, kody.run, kentcdodds.com, and retired heykody.* / kodyapps.dev.`
2. `Password manager: vault / item names for every secret in this inventory (including SECRET_ESCROW_PASSPHRASE).`
3. `Password manager: Stripe webhook endpoint id.`
4. `Password manager: Sentry org slug; alert-rule destination; SENTRY_AUTH_TOKEN item name.`
5. `Password manager: Fathom account login item name.`
6. `Password manager: Scarf account login item name.`
7. `Password manager: Kit account login item name.`
8. `Password manager: Discord application name(s) for social login vs shipped-PR bot; guild name.`
9. `Password manager: Google Cloud project / OAuth client name.`
10. `Password manager: X project / app name.`
11. `Password manager: GitHub OAuth App display name; PREVIEW_ENVIRONMENT_ADMIN_TOKEN item name; kody-bot GitHub user login item name.`
12. `Password manager: Cursor API key / cursorApiKey item name.`
