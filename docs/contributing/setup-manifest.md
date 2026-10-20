# Setup manifest

This document describes the infrastructure and secrets that kody expects.

## Cloudflare resources

This project uses the following resources:

- D1 database
  - `database_name`: `<app-name>`
- R2 bucket for the self-hosted Nx remote cache
  - `bucket_name`: `kody-nx-cache`
  - Worker: `kody-nx-cache` at `nx-cache.kody.codes` (`packages/nx-cache`)
  - Production deploy ensures the bucket and a 14-day `v1/` lifecycle (1-day
    incomplete multipart abort) when the cache worker path changes or that
    workflow is dispatched on `main`. The dedicated
    `.github/workflows/nx-cache-deploy.yml` workflow does the same on its own
    `workflow_dispatch` without a full production deploy.
- R2 bucket for operator rollback snapshots
  - `binding`: `OPERATOR_BACKUPS` (origin and platform workers)
  - `bucket_name`: `kody-operator-backups`; previews use
    `{worker}-operator-backups`
  - Production and preview deploys ensure the bucket. Written only by admin
    operations such as [org resource transfer](./org-resource-transfer.md).
- KV namespace for OAuth/session storage
  - `binding`: `OAUTH_KV`
  - `title`: `<app-name>-oauth`
- Cloudflare Email Sending / Email Service Worker binding
  - `binding`: `EMAIL`
  - `wrangler` key: `send_email`
  - Production domains need Cloudflare-side sender/domain verification before
    sends succeed.
- Cloudflare Email Routing for inbound mail
  - Configure MX records and selected route aliases in the Cloudflare dashboard.
  - Route only aliases that should persist inbound mail to the Worker.
  - Production CI also ensures a Routing rule that forwards
    `dmarc@<SYSTEM_EMAIL_DOMAIN>` to a verified destination
    (`DMARC_REPORT_FORWARD_TO`, default `me@kentcdodds.com`) so DMARC aggregate
    reports land in an operator mailbox. Destination verification is
    dashboard-only (Cloudflare sends a confirm link).
- DMARC reporting TXT
  - Production CI upserts `_dmarc.<SYSTEM_EMAIL_DOMAIN>` and
    `_dmarc.<USER_EMAIL_DOMAIN>` (when distinct) to
    `v=DMARC1; p=reject; rua=mailto:dmarc@<SYSTEM_EMAIL_DOMAIN>`.
  - Deploy token needs DNS Edit on the mail zone (`CLOUDFLARE_ZONE_ID`).
- Cloudflare Queue for Email Sending delivery events
  - Production CI ensures `kody-email-delivery` and `kody-email-delivery-dlq`,
    then reconciles `email.sending` event subscriptions for both the user inbox
    domain (`USER_EMAIL_DOMAIN`, e.g. `inbox.kody.codes` →
    `kody-email-delivery-events`) and the system/transactional domain
    (`SYSTEM_EMAIL_DOMAIN`, e.g. `kody.codes` →
    `kody-system-email-delivery-events`) when they differ. Both point at the
    same queue. Signup verification and other `kody@` mail only receive
    delivered/bounced/failed lifecycle events when the system domain is
    subscribed.
  - The API token needs `Workers Queues:Edit`; the domain must already be
    enabled for Cloudflare Email Sending.
- Cloudflare Queue for Artifacts repository lifecycle events
  - Queue: `kody-artifacts-repo-events`
  - Dead-letter queue: `kody-artifacts-repo-events-dlq`
  - Production CI ensures both queues and reconciles an account-level
    `artifacts` event subscription for `repo.created` / `repo.deleted` /
    `repo.pushed`. New repos do not create per-repo `artifacts.repo` push
    subscriptions; leftover per-repo rows are still deleted during artifact
    cleanup. Uses `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`.
  - Production and preview Workers bind `ARTIFACTS` (wrangler `artifacts`,
    namespaces `production` / per-PR `kody-pr-<n>`). Create/get prefer that
    JSRPC binding and fall back to REST when the binding is absent
    (local/tests). Preview ensure creates the per-PR Artifacts namespace and
    rewrites generated origin/platform/runtime configs away from the shared
    committed `preview` template value.
  - The production consumer batches at most 10 messages for 5 seconds, retries
    three times, and routes exhausted messages to the dedicated dead-letter
    queue. Consumers filter by `ARTIFACTS_NAMESPACE` and ignore session fork
    repos, session workspace branch pushes (`sessions/<id>`), and publish
    git-notes (`refs/notes/commits`). Mapped package topics: `repo.pushed`,
    `repo.created`, `repo.deleted`.
- Cloudflare Queue for durable platform-feedback subscription dispatch
  - Producer binding: `PLATFORM_FEEDBACK_DISPATCH_QUEUE`
  - Queue: `kody-platform-feedback-dispatch`
  - Dead-letter queue: `kody-platform-feedback-dispatch-dlq`
  - The production consumer batches at most 10 messages for 5 seconds, retries
    three times, and routes exhausted messages to the dedicated dead-letter
    queue. Production CI ensures both resources.
  - Preview ensure creates a per-PR copy of this queue from the same producer
    binding (`tools/ci/preview-queue-plan.ts`). The committed `kody-preview-*`
    queue names are placeholders the generated config replaces.
  - Queue messages contain only `{ feedbackId }`. The consumer reloads current
    feedback metadata, acknowledges invalid or deleted ids, and retries
    transient load, subscription-discovery, or package-invocation wrapper
    infrastructure failures before routing exhausted messages to the DLQ. Stored
    failures replay under the same idempotency key rather than automatically
    rerunning; terminal handler execution failures stay isolated.
- Cloudflare Queue for durable community-activity subscription dispatch
  - Producer binding: `COMMUNITY_ACTIVITY_DISPATCH_QUEUE`
  - Queue: `kody-community-activity-dispatch`
  - Dead-letter queue: `kody-community-activity-dispatch-dlq`
  - The production consumer uses the same batch, retry, and DLQ settings as
    platform-feedback dispatch. Production CI ensures both resources.
  - Queue messages contain only `{ eventId, kind, activityId }`. The consumer
    reloads the metadata-only activity projection, acknowledges invalid or
    deleted activity, and retries transient lookup, subscription-discovery, or
    package-invocation infrastructure failures.
- Cloudflare Queue for durable community-listing-published subscription dispatch
  - Producer binding: `COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE`
  - Queue: `kody-community-listing-published-dispatch`
  - Dead-letter queue: `kody-community-listing-published-dispatch-dlq`
  - The production consumer uses the same batch, retry, and DLQ settings as
    platform-feedback dispatch. Production CI ensures both resources.
  - Queue messages contain only `{ eventId, listingId }`. The consumer reloads
    the metadata-only listing projection, acknowledges invalid or inactive
    listings, and retries transient lookup, subscription-discovery, or
    package-invocation infrastructure failures. Only first publish enqueues this
    shape. A republish that moves the pinned commit no longer enqueues
    `kind: 'fork_upstream_updated'`. The follow pipeline emits
    `community.fork.upstream_updated` with the same payload. In-flight messages
    of that kind are acknowledged without fan-out.
- Cloudflare Queue for durable package-emitted event dispatch
  - Producer binding: `PACKAGE_EVENTS_DISPATCH_QUEUE`
  - Queue: `kody-package-events-dispatch`
  - Dead-letter queue: `kody-package-events-dispatch-dlq`
  - The production consumer uses the same batch, retry, and DLQ settings as
    platform-feedback dispatch. Production CI ensures both resources.
  - Queue messages carry the full event (emitting user, source package, topic,
    idempotency key, payload, and invocation depth). The consumer resolves the
    emitting user's subscribed packages at delivery time, invokes handlers with
    exactly-once idempotency, acknowledges terminal handler failures, and
    retries pre-execution package-invocation infrastructure failures.
  - Preview and local runtimes without this production-only queue binding
    deliver inline through the same consumer code path so package events remain
    testable.
- Cloudflare Queue for isolated scheduled maintenance
  - Producer binding: `SCHEDULED_DISPATCH_QUEUE`
  - Queue: `kody-scheduled-dispatch`
  - Dead-letter queue: `kody-scheduled-dispatch-dlq`
  - `dlq_depth_alert` does not use this queue. The cron runs it directly and
    opens a Sentry issue when any production dead-letter queue has had
    unacknowledged messages for more than 15 minutes.
  - The production consumer receives one lane message per invocation, permits up
    to 16 concurrent lane invocations, and retries only replay-safe
    `d1_lock_contention` outcomes three times (10s / 30s / 90s backoff) before
    routing exhausted messages to the dedicated dead-letter queue. Other handled
    lane failures and invalid bodies are acknowledged as terminal. Production CI
    ensures both resources.
  - Preview and local runtimes without this production-only queue binding run
    the same registry inline so maintenance behavior remains testable.
- Vectorize indexes for MCP capability search (`CAPABILITY_VECTOR_INDEX`)
  - Production: `kody-capabilities-prod`
  - Preview: `<preview-worker-name>-vectors`, created and deleted per preview by
    `tools/ci/preview-resources.ts` (with metadata indexes) and filled by the
    preview workflow's builtin reindex. `kody-capabilities-preview` is only the
    committed placeholder the generated preview config replaces.
  - Create production once per account, for example:
    `wrangler vectorize create kody-capabilities-prod --dimensions=384 --metric=cosine`.
    **Dimensions must match** the embedding model in
    `packages/worker/src/vectorize/embedding.ts` (`@cf/baai/bge-small-en-v1.5`,
    384 dimensions, `cls` pooling).
- Cloudflare Images binding for package-icon and integration-logo ingest
  - `binding`: `IMAGES`
  - Origin (`packages/worker/wrangler.jsonc`) and platform
    (`packages/platform-worker/wrangler.jsonc`) bind the same Images API.
    Derived community icons and OAuth / MCP logos are fitted to 256px WebP at
    ingest. No extra Cloudflare resource to create; local wrangler uses the
    offline simulator.
- Workers AI binding for semantic search embeddings and ranked-search scoring
  - `binding`: `AI`
  - Production and preview route embedding and Jev Score (`typesafe/jev`) calls
    through this binding. When `AI_GATEWAY_ID` is configured, calls are sent
    through AI Gateway via the Workers AI binding options. `typesafe/jev`
    requires that gateway (authentication plus Unified Billing credits or BYOK);
    embeddings call Workers AI directly when the id is unset.
- Second registrable domain for hosted package apps
  - Production: `kody.run` (zone in the same Cloudflare account, on Cloudflare
    nameservers), served by the runtime Worker via **zone routes** plus proxied
    placeholder DNS records — deliberately **not** a Workers custom domain.
    Per-user package apps are served from
    `https://{username}.kody.run/packages/{leaf}/...`; the apex serves redirects
    (`/@user/packages/...` → per-user subdomain, `/` to the app origin).
    `__Host-kody_pkg_session` is host-only, so each package-app zone has its own
    sessions.
  - **No custom domain in this zone.** The deploy publishes this zone's Worker
    route table, and replacing a zone's routes detaches any Workers custom
    domain in that zone and deletes its DNS record. Package-app hosts therefore
    use zone routes plus proxied placeholder DNS only. Custom domains stay
    reserved for the app-origin zones, whose route tables the deploy never
    publishes.
  - **DNS records (idempotent, per deploy).** Zone routes do not create DNS
    records. Production CI (`tools/ci/production-resources.ts ensure`)
    idempotently ensures proxied records for these names in every package-app
    zone (canonical plus any `PACKAGE_APP_LEGACY_HOSTS`): `kody.run`,
    `*.kody.run`, and `domains.kody.run` → AAAA `100::` (orange-cloud proxied).
    `domains.<apex>` is the Cloudflare for SaaS fallback origin and the CNAME
    target customers point at (ADR 0071). The deploy token needs **DNS:Edit** on
    those zones (in addition to Workers deploy permissions). Forks must create
    the zone and either run `ensure` or add the records manually before the
    first per-user-subdomain deploy.
  - **Zone routes.** `tools/ci/runtime-worker-config.ts` publishes
    `{ pattern: "kody.run/*", zone_name: "kody.run" }`,
    `{ pattern: "*.kody.run/*", zone_name: "kody.run" }`, and
    `{ pattern: "*/*", zone_name: "kody.run" }` on the runtime Worker. The
    catch-all is required for Cloudflare for SaaS custom hostnames and is
    published only for the **canonical** package-app zone (not
    `PACKAGE_APP_LEGACY_HOSTS` zones, which may be shared). More specific
    apex/wildcard routes still win for first-party package-app traffic.
    Cloudflare Universal SSL covers one wildcard label (`*.kody.run`), which is
    enough for `{username}.kody.run`. Do **not** attach `*kody.run/*` to
    `kody-domain-redirect`: that wildcard would shadow the runtime Worker.
    `www.kody.run/*` is the only redirect route on this zone (301 to the app
    origin), matching `www.kody.codes`.
  - The attach happens on deploy, but the routes are **generated, not
    committed**: `writeGeneratedWranglerConfig` derives one `custom_domain`
    route per app-origin var (`APP_BASE_URL` and `APP_LEGACY_HOSTS`) while
    writing `packages/worker/wrangler-production.generated.json`; the
    package-app zone routes are generated into the runtime Worker config. Those
    vars are the single source of truth for both the hosts the Workers route on
    and the domains the deploy attaches, so the two cannot drift.
  - **`routes` replaces the Worker's whole route set — it does not add to it.**
    Omitting an attached custom domain detaches that origin and deletes its DNS
    record. The generator therefore always lists the app origin alongside the
    package-app apex and wildcard zone route, and fails the deploy when
    `PACKAGE_APP_BASE_URL` is set without `APP_BASE_URL` rather than publishing
    a partial set. Any domain attached out-of-band must be added here before the
    next deploy, or that deploy will remove it. List every dual-served legacy
    app host in the `APP_LEGACY_HOSTS` repository variable (comma-separated bare
    hostnames) so generated routes keep those origins attached. List every
    dual-served package-app host in `PACKAGE_APP_LEGACY_HOSTS` so the runtime
    Worker publishes matching apex and wildcard zone routes alongside
    `PACKAGE_APP_BASE_URL`. Production leaves both lists unset.
  - Publishing routes also flips `workers_dev` to `false`, which silently drops
    the `<name>.<subdomain>.workers.dev` trigger (Cloudflare then answers that
    hostname with error 1042). The generator sets `workers_dev: true` alongside
    the routes so that backup access path — which MCP clients may point at, and
    which the deploy's URL fallback looks for — survives.
  - The routes deliberately do **not** live in `packages/worker/wrangler.jsonc`:
    `npm run dev` runs `wrangler dev` against the **production** environment,
    and Wrangler resolves local request URLs against the first configured route,
    so a committed route makes every local request arrive as
    `http://kody.run/...` — canonical URLs, OAuth resource metadata, and login
    redirects then point at the production domain from localhost.
  - Attaching a custom domain needs a deploy token with edit access to the
    target zone. Without it the deploy step fails on the custom domain instead
    of silently skipping it.
  - The domain exists to be a **different registrable domain** from the app
    origin so author-supplied package code is cross-site. Do not point it at a
    subdomain of the app origin, and do not host anything first-party on it. See
    [Hosted package app origin isolation](./security.md#hosted-package-app-origin-isolation).
  - Production forks must register a second domain and set
    `PACKAGE_APP_BASE_URL`; package-app requests return `500` when it is missing
    or not on a separate registrable domain. Confirmed local, preview, and test
    runtimes may leave it unset and use inline serving.
- Workers Observability OTLP destination (account-level)
  - Workers automatic tracing is enabled via `observability.traces` in
    `packages/worker/wrangler.jsonc`; traces are viewable in the Workers
    Observability dashboard with no further setup.
  - Production traces are additionally exported to Sentry through the
    account-level **Traces** destination `sentry-otlp-traces`, referenced from
    `observability.traces.destinations` in the **production** environment only
    (preview and test deploys keep dashboard-only tracing). In the production
    Cloudflare account it points at the `kody-cloudflare` Sentry project's OTLP
    endpoint (`https://<HOST>/api/<PROJECT_ID>/integration/otlp/v1/traces` with
    the `x-sentry-auth: sentry sentry_key=<public key>` header derived from the
    project DSN).
  - Forks must create their own destination under the same name, or remove the
    `destinations` line — deploys can fail on unknown destinations. Create it in
    the dashboard (**Workers Observability → Destinations**, type Traces) or via
    the API:

    ```sh
    curl -X POST \
      "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/observability/destinations" \
      -H "Authorization: Bearer <API_TOKEN>" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "sentry-otlp-traces",
        "enabled": true,
        "configuration": {
          "type": "logpush",
          "logpushDataset": "opentelemetry-traces",
          "url": "https://<HOST>/api/<PROJECT_ID>/integration/otlp/v1/traces",
          "headers": { "x-sentry-auth": "sentry sentry_key=<public key>" }
        }
      }'
    ```

  - Production pins `SENTRY_TRACES_SAMPLE_RATE` to `0` (Wrangler var) so the
    Sentry SDK does not duplicate the exported traces; see
    [environment-variables.md](./environment-variables.md).

The checked-in
[`packages/worker/wrangler.jsonc`](../../packages/worker/wrangler.jsonc)
declares bindings and names but **does not** commit remote D1 `database_id` or
KV `id` / `preview_id`, so forks do not accidentally bind to another project’s
resources.

Production CI deploys ensure these resources exist (create when missing) and
write resolved IDs into `packages/worker/wrangler-production.generated.json`
before migrations and deploy. Preview deploys do the same per preview worker via
`packages/worker/wrangler-preview.generated.json` (see
[`docs/contributing/setup/local-development.md`](./setup/local-development.md)).
Cloudflare deploys do not auto-create these resources from bindings alone, so
the deploy workflow runs `node tools/ci/production-resources.ts ensure` first.

### Disaster-recovery control plane

Production backup **resources** (R2 bucket locks/lifecycle) are provisioned
out-of-band with `tools/ci/backup-resources-cli.ts`. The control-plane
Worker/Workflows under `packages/backup-control-plane/` live in the
independently administered DR Cloudflare account. Its `BACKUP_BUCKET` R2 binding
is private. Immutable prefixes include `daily/`, `weekly/`, `daily/full/`, and
content-addressed `blobs/sha256/`.

Code deploys are automated by the production deploy workflow
(`.github/workflows/deploy.yml` job `deploy-backup-control-plane`) when a `main`
push changes `packages/backup-control-plane/` or `packages/shared/src/backup-*`
inside the 15-commit path-filter lookback, and on every manual
`workflow_dispatch` of that workflow. A longer Validate gap can skip the job
even when `main` still contains those paths; dispatch Deploy on current `main`
HEAD to force the control plane (and every other worker) live. The job uses
`DR_DEPLOY_TOKEN` + `DR_BACKUP_ACCOUNT_ID` (never the production-account
`CLOUDFLARE_API_TOKEN`) and sets `BUILD_COMMIT` to the deploy SHA. Worker
secrets on the control plane remain one-time / out-of-band.

The production Worker also stages non-D1 canonical stores into the same bucket
when `DR_EXPORT_ENABLED=true` (StorageRunner dumps, `EMAIL_BLOBS` /
`COMMUNITY_ASSETS` blobs, published `BUNDLE_ARTIFACTS_KV` source snapshots).
`REPO_SESSION_BLOBS` is ephemeral RepoSession Workspace scratch and is not
exported. The control plane seals complete days and hosts the Access-protected
Admin UI for drills and graduated production restore. See
[Disaster recovery](./disaster-recovery.md).

Use a separate provisioner token (never a Worker secret) to create the bucket
and apply 35-day daily and 400-day weekly lock/lifecycle rules:

```sh
node tools/ci/backup-resources-cli.ts plan \
  --source-account-id "<PRODUCTION_ACCOUNT_ID>" \
  --destination-account-id "<DR_ACCOUNT_ID>" \
  --source-d1 "<PRODUCTION_D1_UUID>:kody" \
  --deny-production-resource kody-email-blobs \
  --deny-production-resource kody-community-assets \
  --deny-production-resource kody-repo-session-blobs
```

`apply` is an explicit mutation and must be run only after reviewing the plan.
The control-plane runtime receives a source-account token with Cloudflare
Account D1 Edit as `CLOUDFLARE_API_TOKEN` (export + production D1 import).
Cloudflare grants this permission account-wide and it can mutate D1; the
runtime's UUID/name allowlist reduces mistakes but does not scope the token.
Keep that token separate from the provisioner token, drill token
(`DRILL_API_TOKEN`), and production→DR S3 credentials on the app Worker.
Scheduling remains inert until the blocking-export benchmark is approved and
both `ENABLE_PRODUCTION_D1_BACKUPS` and `BACKUP_BENCHMARK_APPROVED` are exactly
`"true"`.

Reviewed non-secret control-plane vars include manifest signing key id /
verifying public key, trusted restore baseline id/digest, Access
(`ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`, `ACCESS_ALLOWED_EMAIL`),
`DRILL_ACCOUNT_ID`, and `PRIMARY_WORKER_ORIGIN`. Worker secrets include
`BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, `DRILL_API_TOKEN`,
`RESTORE_CONFIRM_SECRET`, and `DR_RESTORE_SECRET`. Never commit private keys.
Offline CLI restore still trusts only the checked-in manifest public-key,
production-identity, and restore-baseline registries.

### Status page worker

The public status page (`packages/status/`, served at `status.kody.codes` via a
wrangler custom domain on the `kody.codes` zone) is an independently deployed
Worker with a cron trigger and one `StatusStore` Durable Object (SQLite). It
probes public endpoints on the origin worker (`/health`, `/health/components`)
and package-runtime liveness on `kody.run` (`/__runtime/health`), and probes the
jobs worker over a service binding — never through the origin app and never via
a public jobs hostname. It does not probe `kody-platform` HTTP (`kody-platform`
is health-only and not a public product surface). It never touches `APP_DB` (see
decision record [0004](./decisions/0004-status-page-separate-worker.md)).
Component probes do not use the status hostname.

Code deploys are automated by the production deploy workflow
(`.github/workflows/deploy.yml` job `deploy-status-worker`) when a `main` push
changes `packages/status/` inside the 15-commit path-filter lookback, and on
every manual `workflow_dispatch` of that workflow. A longer Validate gap can
skip the job even when `main` still contains those paths; dispatch Deploy on
current `main` HEAD to force it. The job deploys with the production-account
`CLOUDFLARE_API_TOKEN`, sets `BUILD_COMMIT` to the deploy SHA, and syncs the
Email Sending-only `CLOUDFLARE_STATUS_API_TOKEN` GitHub secret as the Worker
secret `CLOUDFLARE_API_TOKEN` so the status worker can send operator alert email
through the Cloudflare Email REST API (from `ALERT_EMAIL_FROM` to
`ALERT_EMAIL_TO`, both non-secret vars in `packages/status/wrangler.jsonc`).
Without that secret, alert sends are skipped and logged.

MCP execute evidence on the status page is a timestamp-only last-success
heartbeat from real authenticated execute completions, plus at most one hourly
synthetic when the last organic success is older than a minute. The public card
is "recent · organic" when that heartbeat is younger than one hour — organic
traffic alone keeps it green. Public status GETs and origin `GET /health` never
trigger that execute. When the status worker's stored last-success is already
older than a minute, public `/` and `/status.json` re-read origin
`GET /health/components` `executeEvidence` so the card can pick up a newer
heartbeat without waiting for the next cron write. The optional origin Worker
secret `MCP_EXECUTE_HEALTH_CANARY_ACCESS_TOKEN` is a dedicated canary OAuth
access token for the synthetic; when it is unset the fallback stays unknown
rather than impersonating a customer, and the card still stays recent from
organic traffic within the hour.

An optional Worker secret `STATUS_INCIDENT_EVENT_SECRET` (synced from the
same-named GitHub Actions secret when present) is shared with the main worker.
On incident open or resolve the status worker POSTs metadata to
`https://kody.codes/__maintenance/status-incidents` so admin packages can
subscribe to `status.incident.opened` / `status.incident.resolved`. The notify
is fire-and-forget with a short timeout so a down or missing secret cannot stall
probes or email. The same bearer authenticates
`POST https://status.kody.codes/__maintenance/incidents/:id/retrospective`,
which attaches an operator writeup to a resolved probe-derived incident on the
status Durable Object, and
`DELETE https://status.kody.codes/__maintenance/incidents/:id`, which removes a
resolved health-check-only incident. Those writes stay on the status worker so
origin / `APP_DB` being down cannot block them. When the GitHub secret is unset,
emit stays skipped and both incident maintenance routes return 503; packages can
reconcile incident open/resolve from the public `/status.json` snapshot.

## Optional Cloudflare offerings

The default footprint stays intentionally small. If you want to add additional
Cloudflare offerings (R2, Workers AI, AI Gateway, or a separate KV namespace for
app data), see:

- `docs/contributing/cloudflare-offerings.md`

## Rate limiting (Cloudflare dashboard)

Use Cloudflare's built-in rate limiting rules instead of custom Worker logic.

1. Open the Cloudflare dashboard for the zone that routes to your Worker.
2. Go to `Security` → `WAF` → `Rate limiting rules` (or `Rules` →
   `Rate limiting rules`).
3. Create a rule that targets auth endpoints, for example:
   - Expression:
     `(http.request.method eq "POST" and http.request.uri.path in {"/auth" "/oauth/authorize" "/oauth/token" "/oauth/register"})`
   - Threshold: `10` requests per `1 minute` per IP (tune as needed).
   - Action: `Block` or `Managed Challenge`.

## Environment variables

Local development uses `packages/worker/.env`, which Wrangler loads
automatically:

- `COOKIE_SECRET` (generate with `openssl rand -hex 32`)
- `SECRET_STORE_KEY` (required; generate with `openssl rand -base64 48`)
- `OIDC_SIGNING_KEY_ID` (non-empty JWT `kid` for MCP OIDC ID tokens; production
  should use a deployment-specific value such as `kody-oidc-2026-09`)
- `OIDC_SIGNING_PRIVATE_KEY_PEM` (PKCS#8 RSA private key PEM for RS256 ID
  tokens; generate with
  `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc.pem`.
  Local dev and tests use the committed example key in `.env.example`;
  production must set a dedicated secret via `sync-worker-secrets`)
- `APP_BASE_URL` (optional; used as the fallback public origin when no request
  URL is available — e.g. workflows and email. Example `https://kody.codes`.
  Most request-scoped app/MCP URLs use the inbound request origin so OAuth
  metadata matches the host the client connected to. Password reset email sends
  require a system email domain and use `kody@<domain>` as the sender — the
  `SYSTEM_EMAIL_DOMAIN` override when set, otherwise the `APP_BASE_URL`
  hostname.)
- `PACKAGE_APP_BASE_URL` (Wrangler `var`; required in production and optional
  for confirmed local/preview/test runtimes; origin for hosted package apps.
  Production sets `https://kody.run` in `packages/worker/wrangler.jsonc`, and
  the deploy publishes apex and wildcard zone routes (`kody.run/*`,
  `*.kody.run/*`) on the runtime Worker (see the Cloudflare resources list above
  — never a custom domain in this zone). Per-user apps use `{username}.kody.run`
  subdomains; production CI ensures the proxied apex and wildcard DNS records.
  Must be a **separate registrable domain** from `APP_BASE_URL` — see
  [Hosted package app origin isolation](./security.md#hosted-package-app-origin-isolation).
  Local dev ignores any value it cannot serve itself, and preview/test leave it
  unset, so those keep serving package apps inline on the app origin. Point it
  at `http://packages.localhost:<port>` in `packages/worker/.env` to exercise
  the two-origin flow locally.)
- `PACKAGE_APP_LEGACY_HOSTS` (optional Wrangler `var` or GitHub Actions
  variable; additional package-app apex hostnames dual-served alongside
  `PACKAGE_APP_BASE_URL`. Generated runtime zone routes replace the whole set,
  so omitting a listed host detaches it and deletes its DNS. Production leaves
  this unset.)
- `PACKAGE_APP_LEGACY_REDIRECT` (optional GitHub Actions variable; exact string
  `true` enables GET/HEAD 308s from `{username}.<legacy-apex>` to
  `{username}.kody.run`. Leave unset to dual-serve. Production leaves this
  unset.)
- `APP_COMMIT_SHA` (optional; set automatically by deploy workflows for
  version-aware `/health` checks)
- `APP_DEPLOY_INFO` (optional; set automatically by deploy workflows as
  base64url JSON. `GET /health` decodes it for commit message/date, commit and
  PR links, and deploy job metadata. Invalid values are ignored.)
- `CLOUDFLARE_ACCOUNT_ID` (required for the Cloudflare Email Service REST API
  fallback used by local mocks and preview deploys)
- `CLOUDFLARE_API_TOKEN` (used by the Cloudflare Email Service REST API fallback
  when local/preview email is routed through the Cloudflare mock or API)
- `SENTRY_DSN` (optional Cloudflare Worker secret; enables error reporting and
  tracing for the Worker and Durable Objects)
- `SENTRY_ENVIRONMENT` (set per deploy via `packages/worker/wrangler.jsonc`
  `vars` as `production`, `preview`, or `test`; optional override via env for
  local dev)
- `SENTRY_TRACES_SAMPLE_RATE` (optional `0`–`1`, defaults to **`1.0`** in code
  when unset; production pins `0` via a Wrangler var — see
  [environment-variables.md](./environment-variables.md))
- `FATHOM_SITE_ID` (optional public Wrangler var; when set, SSR pages embed the
  Fathom Analytics tracker script. Committed for production in
  `packages/worker/wrangler.jsonc`; intentionally unset for local dev, preview,
  and tests — see [environment-variables.md](./environment-variables.md))
- `YOUTUBE_ALLOWED_PLAYLIST_IDS` (optional public Wrangler var; comma-separated
  playlist ids for the `/?youtubeId=` overlay. `none` disables playlists. Unset
  skips playlist fetch. Production and preview set Kent's public playlist in
  `packages/worker/wrangler.jsonc` — see
  [environment-variables.md](./environment-variables.md))
- `YOUTUBE_ALLOWED_VIDEO_IDS` (optional public Wrangler var; extra YouTube video
  ids allowed by the overlay and `/youtube-thumb/:videoId` proxy)
- `YOUTUBE_DATA_API_KEY` (optional origin-only Worker secret; YouTube Data API
  key for the homepage hero chooser playlist order. When unset, origin reads the
  unlisted playlist through YouTube's public browse endpoint — see
  [environment-variables.md](./environment-variables.md))
- `APP_COMMIT_SHA` (used as the Sentry **release** when present, in addition to
  `/health` versioning)
- `CLOUDFLARE_API_BASE_URL` (optional; defaults to `https://api.cloudflare.com`.
  Production email uses the default public API base when this is unset. Local
  `npm run dev` targets the Cloudflare mock unless `SKIP_CLOUDFLARE_MOCK=1`. The
  internal Cloudflare API client expects paths under `/client/v4/`.)
- `ARTIFACTS_NAMESPACE` (optional Worker var; defaults to `default`. Set per
  Wrangler environment in `packages/worker/wrangler.jsonc` — e.g. `production`
  and `preview` — so Artifacts repos are partitioned by deploy environment.)
- `AI_GATEWAY_ID` (optional Worker secret; routes Workers AI embedding and Jev
  Score calls through the configured Cloudflare AI Gateway when set. For
  `typesafe/jev`, that gateway must have authentication enabled and Unified
  Billing credits, or BYOK; authentication off yields HTTP 403, zero credits
  yields HTTP 402. Embeddings work without Gateway; Jev does not.)
- `CAPABILITY_REINDEX_SECRET` (strongly recommended for production — CI skips
  the post-deploy reindex and origin-only execute smoke check when unset;
  optional locally and for previews; bearer auth for
  `POST /__maintenance/reindex-capabilities`. Production deploy refreshes
  builtin capability vectors only (`{ "phases": ["capabilities"] }`). Omit
  `phases` to rebuild memories, jobs, and saved packages too. Saved package
  projections also refresh when packages are saved or published.)
- `JOB_REINDEX_SECRET` (optional Worker secret; bearer auth for
  `POST /__maintenance/reindex-jobs` for a jobs-only Vectorize rebuild. Not
  required for production deploys — job vectors upsert on write. Omit locally
  and for previews unless you need the jobs-only endpoint.)
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`, `X_CLIENT_ID` / `X_CLIENT_SECRET`, `DISCORD_CLIENT_ID`
  / `DISCORD_CLIENT_SECRET` (optional Worker secrets; enable the "Sign in with
  GitHub / Google / X / Discord" login buttons. A `MOCK_`-prefixed client id
  activates the in-worker mock flow on non-production runtimes. See
  `docs/contributing/social-login.md`.)
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_MEMBER_ROLE_ID` /
  `DISCORD_STANDARD_ROLE_ID` / `DISCORD_PRO_ROLE_ID` (optional Worker secrets;
  when bot token and guild id are set, Discord social login best-effort joins
  the official guild. At least one role id enables member/plan role writes on
  login and Stripe plan refresh. The bot needs Create Instant Invite and Manage
  Roles. See `docs/contributing/social-login.md`.)
- `STRIPE_SECRET_KEY` (optional Worker secret; enables Stripe checkout linking,
  billing portal, and `orgs.stripe_plan` refresh. When unset, billing degrades
  to manual plans.)
- `STRIPE_WEBHOOK_SECRET` (optional Worker secret; Stripe webhook signing secret
  for `POST /webhooks/stripe`. When unset, the webhook endpoint returns 503.)
- `STRIPE_API_BASE_URL` (optional; defaults to `https://api.stripe.com`.
  Override for tests/mocks.)
- `STRIPE_PRO_PRICE_ID` (optional public Wrangler var committed in
  `packages/worker/wrangler.jsonc`; Stripe Price id for the purchasable
  $12/month Pro with the prepaid credit wallet, used for authenticated Checkout
  Sessions.)
- `STRIPE_PRO_YEARLY_PRICE_ID` (optional public Wrangler var committed in
  `packages/worker/wrangler.jsonc`; Stripe Price id for the purchasable
  $120/year Pro.) Each price id is independent; an unset value only disables
  checkout for that interval.
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` (optional public Wrangler var
  committed in `packages/worker/wrangler.jsonc` for production; Stripe Billing
  Portal configuration `bpc_...` used for Manage subscription and the prorated
  `subscription_update` flow that existing subscribers use to switch plans.
  Preview and test leave it unset so Stripe uses the account default.)

Tests run with `CLOUDFLARE_ENV=test` (set by Playwright) and read local secrets
from `packages/worker/.env`.

## GitHub Actions configuration

Configure these GitHub Actions secrets and variables for workflows:

- `CLOUDFLARE_API_TOKEN` (deploy token: Workers deploy + D1 edit access on the
  correct account for wrangler and `tools/ci` resource ensure; also reused for
  remote AI and Cloudflare API workflows that run with account secrets + package
  workflows. The production deploy never uploads it to a Worker.)
- `CLOUDFLARE_APP_API_TOKEN` (required for production deploys; uploaded to
  `kody-production` and `kody-platform` as their `CLOUDFLARE_API_TOKEN` Worker
  secret. Needs `Account · Email Sending · Edit`, `Account · Artifacts · Edit`,
  `Account · Account Analytics · Read` (Analytics Engine SQL for admin insights
  and usage rollups), and `Account · Queues · Edit` (Artifacts push
  event-subscription lookup and cleanup).)
- `CLOUDFLARE_RUNTIME_API_TOKEN` (required for production deploys; uploaded to
  `kody-runtime` as its `CLOUDFLARE_API_TOKEN` Worker secret. The runtime lane
  executes package capabilities in-process, and the only Cloudflare REST APIs
  those reach are Email Sending (`/email/sending/send`) and Artifacts
  (`/artifacts/namespaces/...`, including repo token minting, which has no
  binding equivalent), so this token needs exactly
  `Account · Email Sending · Edit` and `Account · Artifacts · Edit`. Workers AI,
  Images, Vectorize, D1, and Queues are reached through bindings or are not used
  by the runtime lane.)
- `CLOUDFLARE_STATUS_API_TOKEN` (required for production deploys; uploaded to
  `kody-status` as its `CLOUDFLARE_API_TOKEN` Worker secret for operator alert
  email. Needs only `Account · Email Sending · Edit`.)
- Production deploys fail in a shared `require-worker-tokens` job (before
  jobs/highlight/origin/status mutations) when `CLOUDFLARE_APP_API_TOKEN`,
  `CLOUDFLARE_RUNTIME_API_TOKEN`, or `CLOUDFLARE_STATUS_API_TOKEN` is unset or
  equals `CLOUDFLARE_API_TOKEN`, or when `CLOUDFLARE_API_TOKEN` itself is unset
  (`tools/ci/check-worker-cloudflare-tokens.ts`). There is no fallback to the
  deploy token.
- `CLOUDFLARE_ACCOUNT_ID` (required GitHub Actions **variable** for Cloudflare
  resource provisioning and Email Service)
- `CLOUDFLARE_ZONE_ID` (required GitHub Actions **variable** for the zone that
  owns the user email sending domain; Email Sending event subscriptions require
  both this zone id and the domain)
- `PACKAGE_APP_ZONE_ID` (GitHub Actions production environment **secret** or
  **variable**; Cloudflare zone id for the package-app SaaS zone — production
  `kody.run`. Deploy prefers `secrets.PACKAGE_APP_ZONE_ID`, then
  `vars.PACKAGE_APP_ZONE_ID`. Written into origin and platform Worker vars so
  custom-hostname add/sync/reconcile can call the Custom Hostnames API. Required
  before enabling `package-app-custom-domains`.)
- `CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN` (optional GitHub Actions **secret**;
  zone-limited **SSL and Certificates Edit** on the package-app SaaS zone.
  Synced to `kody-production` and `kody-platform` when present. Do not reuse
  `CLOUDFLARE_API_TOKEN`. Required before enabling
  `package-app-custom-domains`.)
- `COOKIE_SECRET` (same format as local)
- `SECRET_STORE_KEY` (same format as local; required for deploys; also sealed
  into the DR bucket via `.github/workflows/dr-escrow.yml` using
  `SECRET_ESCROW_PASSPHRASE` plus `DR_BACKUP_*` S3 credentials — see
  [Disaster recovery](./disaster-recovery.md))
- `APP_BASE_URL` (required GitHub Actions **variable** used by the deployed
  Worker as the fallback public app origin when no request URL is available —
  workflows, password-reset email sender hostname — and written into the
  generated Worker `vars` config before deploy. Request-scoped MCP/app URLs use
  the inbound request origin.)
- `AI_GATEWAY_ID` (optional for production deploys; enables AI Gateway routing
  for Workers AI embeddings and Jev Score. `typesafe/jev` requires this gateway
  to have authentication enabled and Unified Billing credits or BYOK)
- `AI_GATEWAY_ID_PREVIEW` (optional for preview deploys; enables AI Gateway
  routing for Workers AI embeddings and Jev Score; same auth/credits requirement
  for `typesafe/jev`)
- `SENTRY_DSN` (optional; create a JavaScript/Cloudflare project in Sentry and
  paste the DSN; syncs to the Worker as a secret when set in GitHub Actions)
- `YOUTUBE_DATA_API_KEY` (optional origin-only; YouTube Data API key for the
  homepage hero chooser. Unset is fine: origin falls back to public Innertube
  browse. Store as a GitHub Actions secret so production deploy can sync it.)
- `CAPABILITY_REINDEX_SECRET` (strongly recommended for production; optional
  locally and for previews; authenticates post-deploy maintenance calls such as
  capability reindex — CI skips those calls when it is unset)
- `JOB_REINDEX_SECRET` (optional; authenticates
  `POST /__maintenance/reindex-jobs` for a jobs-only Vectorize rebuild.
  Production deploys do not require it — job vectors upsert on write.)
- `DR_BACKUP_ACCOUNT_ID` / `DR_BACKUP_BUCKET_NAME` / `DR_BACKUP_ACCESS_KEY_ID` /
  `DR_BACKUP_SECRET_ACCESS_KEY` (production DR staging into the DR bucket; also
  used by `.github/workflows/dr-escrow.yml`. `DR_BACKUP_ACCOUNT_ID` is also the
  Cloudflare account id for control-plane deploys. Pair with Worker var
  `DR_EXPORT_ENABLED=true` only after enablement — see
  [Disaster recovery](./disaster-recovery.md))
- `DR_DEPLOY_TOKEN` (DR-account API token for `deploy-backup-control-plane` in
  `.github/workflows/deploy.yml`. Needs Workers Scripts Edit/Read, Account
  Workers Scripts Edit, and Workflows Edit on the DR account only — keep
  separate from production `CLOUDFLARE_API_TOKEN`)
- `DR_RESTORE_SECRET` (shared bearer for control-plane →
  `POST /__maintenance/dr-restore`)
- `SECRET_ESCROW_PASSPHRASE` (operator passphrase for sealing `SECRET_STORE_KEY`
  into `escrow/secret-store-key.v1.json`; keep the same value in the personal
  password manager)
- `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET`,
  `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_X_CLIENT_ID` /
  `OAUTH_X_CLIENT_SECRET`, `OAUTH_DISCORD_CLIENT_ID` /
  `OAUTH_DISCORD_CLIENT_SECRET` (optional; social login provider app
  credentials. The production deploy workflow syncs them to the Worker as the
  unprefixed `GITHUB_CLIENT_ID`-style secrets — the `OAUTH_` prefix exists
  because GitHub Actions reserves the `GITHUB_*` secret namespace. See
  `docs/contributing/social-login.md` for provider app setup.)
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_MEMBER_ROLE_ID` /
  `DISCORD_STANDARD_ROLE_ID` / `DISCORD_PRO_ROLE_ID` (optional; official Kody
  Discord guild join and role sync. Synced to the Worker under the same names.
  The bot needs Create Instant Invite and Manage Roles.)
- `KIT_API_KEY` (optional GitHub / Worker secret; Kit / kit.com API key for
  exist-only lifecycle tagging when the email already exists in Kit. Production
  deploy syncs it when set; without it, account events skip Kit. Preview deploys
  intentionally omit the key so preview/E2E do not write to the production Kit
  audience. Create a Kit API key at
  https://app.kit.com/account_settings/developer_settings and use the same value
  as the Kody user secret `kitApiKey` when convenient.)
- `STRIPE_SECRET_KEY` (optional GitHub / Worker secret; Stripe secret API key
  for account billing. Production deploy syncs it when set. The Standard and Pro
  price ids are public Wrangler vars committed in
  `packages/worker/wrangler.jsonc`, not GitHub secrets.)
- `STRIPE_WEBHOOK_SECRET` (optional GitHub / Worker secret; Stripe endpoint
  signing secret (`whsec_...`) for platform billing webhooks at
  `POST /webhooks/stripe`. Production deploy syncs it when set.)
- `KODY_WEBHOOK_URL_RUN` (optional GitHub **secret**; weekly site-perf workflow
  only. When a `needs-fix` verdict is recorded,
  [`.github/workflows/weekly-site-perf.yml`](../../.github/workflows/weekly-site-perf.yml)
  `POST`s this minted inbound webhook URL for `@kentcdodds/weekly-site-perf`
  webhook `run` (`inputMode: "params"`, `responseMode: "sync"`). The value is
  the Kody user secret `weeklySitePerfWebhookRun`
  (https://kody.codes/@<slug>/-/secrets/user/weeklySitePerfWebhookRun); Kent
  copies it into GitHub. Agents never paste the URL. Not a Worker secret; the
  weekly job skips invoke when this is unset, blank, or not a valid `http(s)`
  URL.)
- `SENTRY_AUTH_TOKEN` (optional GitHub **secret**; Sentry auth token with
  `project:releases` / source map upload permissions — used only by CI to run
  `npm run sentry:upload-sourcemaps` after deploy)
- `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (optional GitHub **secret**; write
  bearer for the Nx HTTP cache worker at `https://nx-cache.kody.codes`. Generate
  with `openssl rand -hex 32`. Production deploy and the dedicated
  `🧊 Nx cache worker` workflow sync it to the worker as `CACHE_ACCESS_TOKEN`.
  Use the same value in Cursor Cloud Agent environments so agent `validate` /
  `test:push` can populate the cache. Same-repo validate (`push`,
  `workflow_dispatch`, and non-fork `pull_request`) uses this write token too.
  Leave unset to run without remote writes.)
- `NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN` (optional GitHub **secret**; read
  bearer for the same worker. Generate a second `openssl rand -hex 32` value,
  not the write token. Fork `pull_request` validate jobs set Nx's
  `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` from this secret so they can GET
  and cannot PUT. The worker syncs it as `CACHE_READ_TOKEN`. PUT with this token
  returns 403. Leave unset to run fork CI without any Nx cache.)
- **Repository variables** `SENTRY_ORG` and `SENTRY_PROJECT` (optional; Sentry
  organization and project **slugs** for source map upload — same values as in
  the Sentry wizard’s `--org` / `--project` flags)

How to get/set each value:

- `CLOUDFLARE_API_TOKEN`
  - In Cloudflare Dashboard, create an API Token with permissions to deploy
    Workers and edit D1 on the target account. This is the same token to reuse
    for remote AI and Cloudflare API workflows that run with account secrets and
    saved packages; when you do, also include the product permissions needed for
    those APIs.
  - In GitHub: `Settings` → `Secrets and variables` → `Actions` →
    `New repository secret`.
- `COOKIE_SECRET`
  - Generate locally: `openssl rand -hex 32`
  - Store the exact value as a repository secret in GitHub Actions.
- `APP_BASE_URL` (optional)
  - Use your production app URL (for example `https://kody.codes`) as the
    fallback public origin for workflows and password-reset email.
  - Add it when password reset email should send; the sender is
    `kody@<system email domain>` (the `SYSTEM_EMAIL_DOMAIN` override when set,
    otherwise the `APP_BASE_URL` hostname), so verify that sender/domain in
    Cloudflare Email Service.
  - It also lets deploy-time health/version checks use a fixed URL.
  - Production CI writes this into the generated Wrangler `vars` config before
    deploy, rather than syncing it as a Worker secret.
  - Request-scoped MCP/app URLs use the inbound request origin so OAuth resource
    metadata matches the host the client connected to.
  - Do not also upload `APP_BASE_URL` through `wrangler secret bulk` or pass it
    as a deploy-time `--var`, because Wrangler treats that as a conflicting
    binding name.
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID`
  - Copy both identifiers from the Cloudflare dashboard overview for the
    production zone.
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    each under its exact name.
- `USER_EMAIL_DOMAIN` (optional GitHub Actions **variable**; overrides
  `inbox.<APP_BASE_URL hostname>` for user inboxes, outbound senders, and the
  user-inbox Email Sending event subscription).
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    it only when the production user email domain differs from the default.
  - Production also commits `USER_EMAIL_DOMAIN=inbox.kody.codes` (and
    `SYSTEM_EMAIL_DOMAIN=kody.codes`) in `packages/worker/wrangler.jsonc` so the
    email domains can never silently rederive from `APP_BASE_URL`; the deploy
    tooling reads the same committed pins and reconciles Email Sending event
    subscriptions for both domains when they differ. Optional
    `LEGACY_USER_EMAIL_DOMAINS` / `LEGACY_SYSTEM_EMAIL_DOMAINS` accept inbound
    mail to additional addresses on the same inboxes; production leaves those
    lists unset.
- `APP_LEGACY_HOSTS` / `APP_LEGACY_REDIRECT` (optional GitHub Actions
  **variables** for dual-served app hosts; see
  [environment-variables.md](./environment-variables.md#app-origin-and-domain-migration)).
  - `APP_LEGACY_HOSTS` lists additional app hostnames (comma-separated) that
    stay attached to the Worker as custom domains and are dual-served.
    Production leaves this unset.
  - `APP_LEGACY_REDIRECT=true` enables 308 redirects for browser GET/HEAD
    navigation from those hosts to the canonical origin; protocol surfaces
    (`/mcp`, OAuth, well-known, auth callbacks, webhooks, health) always keep
    serving directly.
- `PACKAGE_APP_LEGACY_HOSTS` / `PACKAGE_APP_LEGACY_REDIRECT` — package-app
  dual-serve; see
  [environment-variables.md](./environment-variables.md#hosted-package-app-origin).
  Production leaves both unset.
- `AI_GATEWAY_ID`
  - Create a Cloudflare AI Gateway in the dashboard and copy its production
    gateway ID. The Worker uses this for Workers AI embedding and Jev Score
    calls when set. Embeddings call Workers AI directly when unset;
    `typesafe/jev` cannot — ranked-search Jev Score requires this gateway.
    Enable authentication on the gateway and keep Unified Billing credits (or
    provide BYOK). Authentication off yields HTTP 403; zero credits yields
    HTTP 402.
  - Store that value as the production GitHub Actions secret.
- `AI_GATEWAY_ID_PREVIEW`
  - Create a separate Cloudflare AI Gateway for previews and copy its gateway
    ID.
  - Store that value as the preview GitHub Actions secret so preview deploys
    sync a different worker secret than production.
- `KODY_WEBHOOK_URL_RUN` (optional)
  - Minted inbound webhook URL for `@kentcdodds/weekly-site-perf` webhook `run`.
  - Kent copies the value from the Kody user secret `weeklySitePerfWebhookRun`
    at https://kody.codes/@<slug>/-/secrets/user/weeklySitePerfWebhookRun into
    the GitHub Actions repository secret `KODY_WEBHOOK_URL_RUN`. Agents never
    paste the URL.
  - The weekly workflow uses this secret only to invoke that package; it is not
    synced to the Worker. Rotate with `webhookUrlRotate`, then update both the
    Kody user secret and this GitHub secret.
- `SENTRY_DSN` (optional)
  - In Sentry: create a project, copy the DSN, and add it as the repository
    secret `SENTRY_DSN`. Production and preview deploy workflows sync it with
    `sync-worker-secrets.ts` when the secret is present.
- `SENTRY_AUTH_TOKEN` (optional)
  - In Sentry: **Settings → Auth Tokens** (or Organization settings), create a
    token that can upload releases/source maps, and store it as the
    `SENTRY_AUTH_TOKEN` repository secret.
- `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (optional)
  - Generate locally: `openssl rand -hex 32`
  - Store the exact value as the repository secret
    `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, and use the same value in Cursor
    Cloud Agent environments (write token). Production deploy and the dedicated
    `🧊 Nx cache worker` workflow sync it to the `kody-nx-cache` Worker as
    `CACHE_ACCESS_TOKEN`. After rotating the GitHub secret, run that workflow on
    `main` so the worker secret matches. Same-repo validate presents this write
    token to Nx.
- `NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN` (optional)
  - Generate a second `openssl rand -hex 32` value. Store it as the repository
    secret `NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN` only. Do not put this value
    on Cloud Agent environments. The same deploy workflow syncs it as
    `CACHE_READ_TOKEN`. After adding or rotating the GitHub secret, run that
    workflow on `main` so the worker secret matches. Fork `pull_request`
    validate uses this token so a fork cannot PUT.
- `SENTRY_ORG` / `SENTRY_PROJECT` (optional)
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    `SENTRY_ORG` and `SENTRY_PROJECT` with your Sentry slugs (for example from
    `npx @sentry/wizard@latest -i sourcemaps`).
- `CAPABILITY_REINDEX_SECRET` (strongly recommended for production; optional
  locally and for previews)
  - Generate a long random secret (for example `openssl rand -hex 32`), store it
    as the repository secret `CAPABILITY_REINDEX_SECRET`, and let the deploy
    workflow sync it to the Worker. After each production deploy, CI POSTs
    `{ "phases": ["capabilities"] }` to `/__maintenance/reindex-capabilities`
    with `Authorization: Bearer …` and loops on the returned `cursor` until
    `complete` is true (each POST is bounded to about 70 seconds; CI follows the
    cursor for up to 8 sweeps), refreshing builtin capability embeddings.
    User-owned memory, job, and saved-package vectors upsert on write. Unchanged
    embed text and Vectorize metadata (same model, dimensions, and fingerprint
    version) skip embed and Vectorize upsert. For a full rebuild after changing
    the embedding model, pooling, or Vectorize index dimensions, POST
    `{ "force": true }` without `phases` and follow the same cursor loop so
    existing rows are rebuilt with compatible vectors. Pooling is not part of
    the fingerprint, so a pooling-only change also needs `force` (or a
    `vectorEmbedFingerprintVersion` bump). After Vectorize data loss, `force` is
    required so restored D1 fingerprints cannot skip an empty index. Local
    environments can omit it; production CI skips reindex and origin-only
    execute-smoke when the secret is unset. Preview deploys generate a random
    per-deploy value and run the builtin reindex against the per-preview index.
- `JOB_REINDEX_SECRET` (optional; jobs-only reindex)
  - Bearer token for `POST /__maintenance/reindex-jobs`. Generate and sync the
    same way as `CAPABILITY_REINDEX_SECRET` only if you want the jobs-only
    maintenance endpoint. Production deploys do not require it; job vectors
    upsert on write. Local and preview can omit it.

Preview deploys for pull requests create an app Worker per PR named
`<app-name>-pr-<number>` (for kody: `kody-pr-123`), sibling platform, runtime,
and jobs Workers (`…-platform`, `…-runtime`, `…-jobs`), plus one Worker per mock
service named `<app-name>-pr-<number>-mock-<service>`. The same
`CLOUDFLARE_API_TOKEN` must be able to create/update and delete those Workers.
