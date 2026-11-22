# Storage services

[Data storage overview](./index.md)

## D1 (`APP_DB`)

Relational app data lives in D1.

TEXT `user_id` (and `owner_user_id`) columns hold an `OwnerId`: the org that
owns the row, either a team org or a personal org. Legacy personal orgs reuse
the person's `stable_user_id` as their id; newer personal orgs get a distinct id
recorded on `users.personal_org_id`. The column names stay as they are. Columns
that record who acted hold a `PersonId`. Both types come from
`@kody-internal/shared/owner-person-ids.ts`; see
[decision 0060](../../decisions/0060-owner-and-person-ids.md).

The schema is defined by migrations in `packages/worker/migrations/`:

- `users`: login identity and password hash, plus the persisted stable MCP
  `userId` (`stable_user_id`, with a NOT NULL unique index in
  `0001-squashed-init.sql`). Signup mints it as 32 random bytes in hex
  (`mintPersonId`); it is opaque, never derived from the email, and never
  reminted. Accounts created before random minting carry SHA-256 of their signup
  email, so a stored id can reveal or confirm an email address: never expose
  stable ids publicly, and never recompute one from an email. Emails are claims
  on that identity (`user_email_claims`): changing email keeps the previous
  verified address claimed so it cannot open a second account until the owner
  re-verifies and releases it. A released address can sign up as a new account
  with its own new random id. Email change requires a verified current address
  (`users.email_verified_at` is non-null). A former-email claim collision at
  signup is a controlled 409 (`former_email_claimed`) that does not leak the
  account's current email. Only `users.email` and active `user_email_claims`
  rows reserve an address; a legacy email-hash id reserves nothing. Optional
  community profile fields are `display_name`, `bio`, and `profile_visibility`
  (default `public`). `experiments_opt_in` is the account preference for the
  feature-flag `experiments_opt_in` audience, edited at `/account/experiments`.
  Every `users` row is a person account. First-touch marketing columns (`utm_*`,
  `first_touch_landing_path`, `first_touch_referrer`) store signup attribution
  when present. Activation and return columns (`first_mcp_connected_at`,
  `first_execute_at`, `first_search_at`, `first_saved_package_at`,
  `first_secret_at`, `first_integration_at`, `first_job_at`, `mcp_client_name`,
  `last_active_at`) support product metrics; email verification delivery columns
  track the latest transactional verify-mail outcome. `user_tips_email_opt_outs`
  is the durable Kody tips opt-out (usage-state campaign mail only). Billing,
  Stripe, gift, and referral-overlay columns live on the person's personal
  `orgs` row (see `orgs` below and [Entitlements](../entitlements.md)).
  Pre-signup attribution lives in two one-week first-party cookies: the
  first-touch-wins `kody_first_touch` (UTMs, landing path, referrer; the browser
  writes it, signup reads it server-side and clears it) and the last-wins
  `kody_ref` referral cookie. `referrals` stores the signup-time row
  (`referrer_stable_user_id`, `referee_stable_user_id`) and the invoice-gated
  reward ledger (`status`, `reward_invoice_id`, held invoice fields while email
  is unverified). See [Entitlements](../entitlements.md#referral-pro-credit).
  The `d1_storage_reconciliation` lane sweeps live owners (personal orgs by
  `users.stable_user_id` and team orgs by `orgs.id`) in one keyset from the
  platform-owned `d1_storage_reconcile_cursor` singleton. UserMeter
  `storage_bytes_state` (schema v4) drives storage-byte enforcement; see
  [Entitlements](../entitlements.md#usermeter). Inbound email routing does not
  reverse-resolve stable ids — it uses the indexed username lookup
  (`findPublicUserIdentityByUsername`) on the RFC 5233 base local
  (`resolveInboundMailboxRoute`). Plus-tags on user inbox hosts are aliases for
  that username, including tags that spell a reserved system local. Contextless
  paths resolve stable ids with one indexed point read on `users.stable_user_id`
  (for example `findUserAccountByStableUserId`). Person accounts that stay
  unverified for seven days (`email_verified_at` is null, no `oauth_connections`
  row) are deleted by the hourly `unverified_account_purge` lane through the
  inventory-driven account-deletion path, which releases the username,
  `{username}.kody.run` subdomain, `{username}@` mail local, and
  `stable_user_id`. Each candidate is claimed with an atomic `UPDATE` that
  restamps `deleting_at` only while that eligibility still holds. Once claimed,
  email verification and social-login reclaim refuse the fenced row, so the
  account cannot become eligible again. A claim-created fence is released only
  on pre-cleanup failures (active writers or inventory); a partial-cleanup
  failure leaves the fence for retry. Never-attempted rows are processed before
  retries, and in-backoff fences are skipped.
- `orgs` (`0086-teams-orgs-tables.sql`, `0087-teams-soft-delete-columns.sql`,
  `0088-teams-actor-columns.sql`, `0089-teams-orgs-backfill.sql`): one row per
  org. Personal orgs reuse `users.stable_user_id` as `orgs.id`. Billing,
  profile, gift, and budget columns live on the org row. Soft-delete and actor
  columns exist on the row. See
  [decision 0063](../../decisions/0063-teams-expand-orgs.md).
  `profile_visibility` (`public` default | `private`) decides whether a team
  org's `/@slug` page and avatar are visible outside the org (set at create and
  in org Settings / `orgUpdate`); personal orgs follow
  `users.profile_visibility` instead
  ([decision 0088](../../decisions/0088-public-team-org-pages.md)).
  `usage_warnings_enabled` (0234, default 1) gates the 80% / 100% usage emails
  and the execute usage heads-up for personal and team orgs (`orgUpdate`
  `usage_warnings`).
- `handles` (0086): the username namespace. Handles are permanent (no username
  or org slug renames); rows left by pre-rule renames stay reserved.
- `org_memberships` (0086): `(org_id, user_id)` with role `owner`, `admin`,
  `member`, or `billing` (`admin` since 0261). Signup writes the person as Owner
  of their personal org.
- `platform_feedback`: attributed, user-approved Kody feedback and admin triage
  state. Submitter identity remains on the row; optional reviewer attribution is
  cleared if that admin account is deleted. Open and triaged rows remain until
  they are resolved, dismissed, or the submitting account is deleted. Resolved
  and dismissed rows are pruned 365 days after `updated_at`; submitter deletion
  removes any remaining rows.
- Package access uses org grants and Owner memberships. There is no
  `package_scope_grants`, `package_share_grants`, or `username_redirects` table.
  Reserved old handles live in `handles`.
- `password_resets`: hashed reset tokens with expiry and foreign key to users
- `guest_accounts`: Try it out person plus personal org. `claim_code` is a
  SHA-256 lookup hash; `claim_code_encrypted` is the sealed plaintext (purpose
  `guest-claim-code`). Lookup hashes the presented code; display opens the seal.
  A successful claim clears the ciphertext.
- Workflow, activation, and package-success state lives in dedicated RunLog
  tables; D1 has no corresponding projection tables (see
  [Run records](../run-records.md)).
- There is no `jobs` table in `APP_DB` — it lives in the jobs worker's `JOBS_DB`
  (see [D1 (`JOBS_DB`)](#d1-jobs_db)). `JOBS_DB` has no `archived_job_artifacts`
  table.
- There is no `repo_sessions` table in `APP_DB`. The catalog lives in the
  per-user `RepoSessionIndex` Durable Object. D1 keeps only the thin
  `repo_session_due_owners` hint and the platform-owned
  `repo_session_storage_bucket_cursor`.
- `entity_sources`: durable mapping from user-facing entities (`package` or
  `repo`) to Artifacts repos and their latest published commit (packages only;
  plain repos are live-at-HEAD without a publish pointer)
- `user_repos`: plain-repo discovery metadata (`name`, optional `description`);
  one row per user-owned plain repo, keyed by `entity_sources.entity_id` when
  `entity_kind = 'repo'`
- `saved_packages`: package metadata/search projection derived from published
  `package.json` source, plus a user-scoped `hidden` flag (0/1) that excludes
  the package from default ranked search while leaving list/get/execute paths
  intact, `is_private` (0/1) for repo visibility (default private; not
  `package.json#private`) used by public-profile catalog filters, `locked_at`
  (nullable ISO timestamp) that blocks agent and reconcile promotion of
  `published_commit` until the owner approves a specific commit in the account
  UI, and `has_skills` (0/1) set at publish when the package ships one or more
  `skills/<name>/SKILL.md` trees (Skills-over-MCP index lookup)
- `mcp_event_subscriptions` (`0083-mcp-event-subscriptions.sql`): user-owned MCP
  Events webhook subscriptions (event name, callback URL, encrypted `whsec_`
  secrets). Deleted and exported with the account; secret columns are redacted
  from export. See [MCP Events](../../../guides/mcp-events.md),
  [0059](../../decisions/0059-mcp-events-extension-behind-flag.md), and
  [0087](../../decisions/0087-mcp-events-no-client-declaration.md).
- `community_listings`, `community_forks`, `community_ratings`,
  `community_reports`, `community_bans`: public package listings and moderation
  (see [Public packages](../../community-packages.md)). `community_forks` rows
  for a saved package are removed on package delete (`packageDelete` / account
  package delete) and by D1 `AFTER DELETE` triggers on `saved_packages` and
  `entity_sources` (`0061-community-forks-package-delete-cascade.sql`). Inert
  forks keep an `entity_sources` row and no `saved_packages` row, so a foreign
  key from `forked_package_id` cannot be declared.
- `community_activity_events`: stored `listing_published` / `listing_updated`
  profile activity events (`actor_user_id` + `listing_id`); public forks are
  derived at read time from `community_forks`
- `secret_buckets`: encrypted-secret ownership buckets scoped to `user`,
  `package`, or `session`. Package buckets bind directly to `saved_packages.id`;
  package runtimes may use their own package secrets. `secretList` can list
  caller-owned package-bucket metadata (with `package_id`) from execute without
  a package runtime binding; resolve, fetch placeholders, and mounts still
  require package context. Search ranks user-scoped secret references only. User
  secrets are auto-granted for read/use to self-authored packages (no
  `community_forks` row for that `saved_packages.id` + `userId`) and adopted
  forks (`community_forks.adopted_at`, set only by the signed-in owner on the
  package settings page). Packages from another org (including `@kody`) run only
  after `communityFork` copies them into the caller's org. Unadopted community
  forks (`community_forks.forked_package_id`, indexed in the squashed baseline)
  still require an explicit `allowed_packages` grant on every package read path.
  Updating or deleting a user secret from package code (`secretSet` /
  `secretDelete`) always requires that grant, regardless of fork or adoption
  state. Official OAuth token rotation persists host-side and does not use that
  write grant. Host allowlists (`secret_entries.allowed_hosts`) stay a separate
  gate and are never implied by authorship or adoption.
- `user_oauth_apps` (`0001-squashed-init.sql`): per-user OAuth app rows keyed by
  `(user_id, slug)`. Holds shared client id, client-secret ciphertext, provider
  endpoints, and flow options. See [OAuth integrations](../integrations.md).
- `platform_oauth_apps` (`0004-platform-oauth-apps.sql`): operator-provisioned
  built-in OAuth apps. Global operator config with **no `user_id`** (like
  feature flags, not user data). Keyed by `slug`; holds the inline non-secret
  `client_id`, provider endpoints, flow options, the allowed/default scope menu,
  `required_hosts_json`, `enabled` (hard kill), and `visibility`
  (`0075-platform-oauth-app-visibility.sql`; `draft` | `published`, default
  `draft`). Only enabled + published apps are discoverable and accept new
  connects; draft apps keep serving existing connections.
  `client_secret_encrypted` is the one credential ciphertext stored outside
  `secret_entries` (AES-GCM with a dedicated purpose, so no `{{secret:…}}`
  placeholder can name it); `getPlatformOauthAppClientSecret` in
  `packages/worker/src/integrations/platform-apps.ts` is its only decrypt
  accessor. `logo_key` / `logo_content_type`
  (`0005-platform-oauth-app-logos.sql`) point at an operator-owned provider logo
  asset in the `COMMUNITY_ASSETS` R2 bucket (content-hashed
  `platform-oauth-app-logos/{slug}/` keys; uploads are fitted to 256px WebP
  before storage). See
  [OAuth integrations](../integrations.md#platform-built-in-oauth-apps).
- `platform_provider_marks` (`0035-platform-provider-marks.sql`): operator-owned
  brand marks for saved integrations, keyed by `slug`, with no `user_id`.
  `aliases_json` holds extra provider keys and authorize hosts. `logo_key` /
  `logo_content_type` point at a fitted WebP in `COMMUNITY_ASSETS` under
  `platform-provider-marks/{slug}/`. Display uses these after an explicit upload
  and before auto-favicon. See
  [OAuth integrations](../integrations.md#provider-logos).
- `user_integrations` (squashed baseline, rebuilt by
  `0004-platform-oauth-apps.sql`): per-user OAuth connections keyed by
  `(user_id, name)`. Exactly one of nullable `app_slug` (composite FK
  `(user_id, app_slug) → user_oauth_apps(user_id, slug)`) or nullable
  `platform_app_slug` (FK to `platform_oauth_apps(slug)`) is set, enforced by a
  `CHECK` constraint; both FKs use `ON DELETE RESTRICT`. Holds `scopes_json`,
  `required_hosts_json`, `usage_mode` / `allowed_packages_json`, and access /
  refresh token ciphertext. The non-secret `client_id` is stored inline on the
  owning app row. `0202-integration-app-owner.sql` rebuilds the table to add
  nullable `app_owner_id`, the org whose app the connection uses. The app FK is
  `(app_owner_id, app_slug) → user_oauth_apps(user_id, slug)`. User-lane rows
  set `app_owner_id = user_id`. A row whose `app_owner_id` differs from
  `user_id` is a member's personal connection pinned to that org (ADR 0068
  amendment 2026-10-29): tokens live with the member's personal org, the client
  secret with the org's app. Deleting the org's app or the member leaving wipes
  those rows; org transfer rewrites `app_owner_id` with the apps. Team-org soft
  delete wipes and revokes them (`wipePinnedConnectionsForOrg`, reason
  `org_deleted`) before tombstoning the apps; restore does not bring them back.
  Hard purge runs the same wipe, then the `user_integrations_pinned_to_org_apps`
  target in `account/data-targets.ts` (inside `appliesToOrgHardPurge`) deletes
  any row the wipe cannot see, before `user_oauth_apps`, so the
  `ON DELETE RESTRICT` app FK never blocks the purge.

App access pattern:

- `packages/worker/src/db.ts` defines shared `remix/data-table` table metadata
  and creates a D1-backed database runtime via
  `packages/worker/src/d1-data-table-adapter.ts`
- Database row validation and API payload parsing use `remix/data-schema`
- app handlers and the mock Resend worker perform CRUD/query operations through
  `remix/data-table` (including `findOne`, `create`, `update`, `deleteMany`, and
  `count`)

## D1 (`JOBS_DB`)

Job schedule metadata lives in the dedicated `kody-jobs` D1 database bound as
`JOBS_DB` on the jobs worker (`packages/jobs-worker/`), not in `APP_DB`. Schema:
`packages/jobs-worker/migrations/`. The main worker reaches it only through the
`JOBS` service binding (`JobsService`). See
[ADR 0016](../../decisions/0016-mono-worker-extraction.md) and the
[jobs worker migration runbook](../jobs-worker-migration-runbook.md).

- `jobs`: persisted package job metadata, caller context, schedule state,
  package source pointers, and optional `expires_at` (UTC ISO; when reached the
  scheduler skips the job and auto-disables it with `enabled = 0`). After a
  recurring run, the scheduler also turns the job off and emails the org owners
  when it cannot compute the next run. Every row id is a `package-job:` id
  (asserted by migration `0004`, ADR 0032). Rows are created, updated, and
  removed by package publish sync, package deletion, and account deletion;
  `expires_at` stops scheduling only — it does not delete rows. This database
  keeps schedule fields (`next_run_at`, `schedule_json`, …) and `last_run_at` /
  `last_run_status`; terminal run error, duration, and counters for
  observability live in the per-user `RunLog` `job_run_observability` table (see
  [Run records](../run-records.md)).

## Analytics Engine reporting

The role-gated admin insights page reads its 28-day email volume and outbound
delivery-outcome charts from the `EMAIL_EVENTS` Analytics Engine dataset.
Workflow status totals and activation funnel/latency on the same page come from
**bounded, content-free per-user RunLog point reads** (see
[Run records — Admin insights RunLog reads](../run-records.md#admin-insights-runlog-reads)),
not from D1 projection tables. The loader exposes `runLogCompleteness` when that
fanout is partial. Charged sends and receives write one event after entitlement
consumption; persisted `cloudflare-email` provider outcomes write one delivery
event. The layout is `index1 = userId`, `blob1 = event type`,
`blob2 = delivery outcome`, `blob3 = source timestamp`, and `double1 = 1`. Admin
queries return only platform-wide day/outcome counts and weight sampled rows by
`_sample_interval`. When Analytics Engine SQL is unreachable, these two charts
zero-fill while the rest of the page renders. Local development cannot query
Wrangler's emulated Analytics Engine SQL API: both email quota and
delivery-outcome aggregates degrade to empty (with an explicit warning) rather
than falling back to a shared USER email graph.

Mailbox has no mirror/parity telemetry, emitters, or operation registry.

Two D1 reporting projections deliberately remain:

- `usage_rollups` keeps 24 months of per-user monthly aggregates. Analytics
  Engine's account retention is approximately 90 days, so it cannot safely serve
  the 12-month admin trend or preserve the 24-month read model. The hourly
  Analytics Engine recompute and D1 table remain unchanged.
- `user_usage_campaigns` and `user_usage_campaign_sends` store one usage-state
  campaign row per user plus an idempotent send ledger
  (`UNIQUE(user_id, state, send_index)`), plus `first_activated_at` /
  `advocate_sent_at` and a partial unique index that caps
  `advocate_referral_testimonial` at one send forever. The hourly
  `usage_entitlement_alert` lane evaluates verified person accounts and mails
  from `kody@` with the standard transactional template. Seed observations
  persist state without mailing (backfill is out of scope). Activated and Paid
  stay drip-silent except that one-shot advocate mail. LimitAware shares the
  existing entitlement-warning mail. Kit stays exist-only tags. See
  [Usage metering](../usage-metering.md#usage-campaign).
- `agent_package_conversation_uses` records per-user package conversation
  cardinality from MCP `execute` package paths. That path stays on D1 because it
  is latency-sensitive relative to Analytics Engine SQL. A per-user meter
  Durable Object is a possible future home if D1 write contention requires
  another move. MCP server instructions do not read this table.

## KV (`OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`)

OAuth provider state is stored in `OAUTH_KV` through the
`@cloudflare/workers-oauth-provider` integration. Published package source
snapshots, bundle artifacts, and legacy community listing snapshots are stored
in `BUNDLE_ARTIFACTS_KV`. That binding also holds the platform-owned
`platform-settings:v1:reserved-usernames` runtime reserved-username override and
short-lived encrypted MCP OAuth refresh-family snapshots
(`derived-cache:v1:mcp-oauth-refresh-family:` /
`derived-cache:v1:mcp-oauth-refresh-replay:`).

- Bindings are configured in `packages/worker/wrangler.jsonc` (remote KV IDs are
  supplied at deploy time via generated Wrangler configs, not committed in the
  checked-in config).
- `OAUTH_KV` supports OAuth client and token flows without custom storage code
  in the app handlers; account deletion revokes all provider grants for the
  user. Outside the provider's `fetch` wrapper (scheduled purge lane, RPC
  entrypoints, the `MCP` Durable Object on kody-platform) `env.OAUTH_PROVIDER`
  is undefined (and the token endpoint never injects it even on origin), so
  `packages/worker/src/oauth-helpers.ts` builds the same `OAuthHelpers` through
  the library's `getOAuthApi` (loaded on demand from the pre-bundled
  `oauth-provider.mjs` additional module, with the provider options shared from
  `packages/worker/src/oauth-provider-options.ts`) so grant, token, client, and
  OIDC unwrap/lookup calls hit the same keys.
  `packages/worker/src/oauth-purge.ts` models the provider's key layout for the
  orphan/expiry sweep, which the library does not expose.
- `BUNDLE_ARTIFACTS_KV` keys are deleted from account deletion using D1-derived
  source ids, published commits, bundle artifact rows, community listing ids,
  and package ids.

## R2 (`COMMUNITY_ASSETS`, `EMAIL_BLOBS`, `FILE_BLOBS`, `REPO_SESSION_BLOBS`)

Processed public community icons live in the private `COMMUNITY_ASSETS` bucket.
The public icon route reads the active listing first, then resolves a cachified
descriptor from `BUNDLE_ARTIFACTS_KV` and streams the referenced R2 object.
Source files remain in the listing's pinned Artifacts commit; R2 stores only the
256-pixel WebP ingest (Cloudflare Images, `fit: scale-down`) or a generated
fallback.

- Keys use `community-icon:v3/{listingId}/{commit}/asset`, where the commit is
  the listing's icon commit (the owner package's current published commit) or
  its pinned snapshot commit. Derived bytes are a 256-pixel WebP from the
  Cloudflare Images ingest fit. Account deletion also prefix-deletes leftover
  `community-icon:v1/` and `community-icon:v2/` objects.
- Repo- and package-scoped list marks use
  `identity-icon:v1/{repoId}/{commit}/asset` on the same bucket. The taught
  source is `.kody/icon.png` (aliases: `.kody/icon.{svg,webp,jpg,jpeg}`, root
  `icon.*`, root `community-icon.*`, then `icons/icon-192.png` for package
  apps). Package publish and default-branch push prune superseded commits.
  Account deletion prefix-deletes every `entity_sources.repo_id`.
- Descriptor keys include the same listing id and commit, so package publish and
  listing re-publish cannot serve an older icon.
- Unpublish, admin hard delete, and re-publish prune all descriptor and object
  keys under the listing prefix; package publish prunes superseded commits;
  account deletion removes the pinned and icon commit keys derived from D1.
- Bucket names are `kody-community-assets` in production and
  `{worker}-community-assets` for preview deployments.

Raw email MIME payloads live in the `EMAIL_BLOBS` R2 bucket. Mailbox
`email_messages` stores the object key in `raw_mime_key`
(`email-raw:v1:{userId}/{messageId}`). R2 is required for inbound MIME — the
inbound path stores it before `commitInboundMessageGraph`, which writes the
thread, message, and attachments in one owner-Mailbox SQLite transaction and
stores only `raw_mime_key`. The MIME reader accepts wire size up to 25 MiB
(`maxSurvivableInboundRawBytes`, the Email Routing inbound cap). Mail at or
under the owner's plan `email_message_bytes` persist cap (256 KiB free, 768 KiB
paid/max; `maxRawMimeBytes` / `maxKeptInboundRawBytes`) is stored as-is,
including `multipart/related` messages with inline images. Larger accepted mail
is reduced before parse: text/html is kept, oversized parts are omitted as
`unavailable` attachments, and the stored raw MIME stays at or under the persist
cap. R2 or Mailbox commit failures remain retryable; only unsurvivable size
(above 25 MiB) is a permanent SMTP reject. UserMeter delivery-id idempotency
prevents a second charge, and the Mailbox delivery ledger stabilizes retries.
Outbound messages pass `rawMime: null`.

The schema has no inline raw-MIME columns, offload queue, or delete-time claim
protocol. Sender identities accept only `verified` rows, and
`ensurePlatformSenderIdentity` provisions that status.

- Canonical key builders are `emailRawMimeKey` / `emailAttachmentBlobKey` in
  `packages/worker/src/email/blob-keys.ts`.
- USER reads resolve Mailbox metadata and use `loadRawMime` in
  `packages/worker/src/email/service.ts`, which fetches only the Mailbox-owned
  `rawMimeKey`. Attachment content extraction re-parses that resolved MIME.
- USER explicit delete, retention, and account purge call owner Mailbox RPCs.
  Mailbox deletes each canonical raw-MIME/external-attachment R2 object before
  deleting authoritative SQLite metadata; a failed blob delete preserves the row
  and schedules retry. No live path mirrors or repairs a shared D1 graph row.
  There is no shared D1 email graph. `system:email` uses only its dedicated D1
  graph and retention path.
- Bucket names: `kody-email-blobs` (production), per-preview
  `{worker}-email-blobs` buckets created and cleaned up by
  `tools/ci/preview-resources.ts`, and the test env reuses the preview-style
  name locally (Wrangler/vitest-plugin simulate the bucket).

Immutable org-file revision bytes live in the `FILE_BLOBS` R2 bucket by default.
A configured provider can store them in an external R2 or Amazon S3 bucket
(`providerObjectStore`). Account export resolves the provider for each file
object through `fileObjectReader`. `FileStore` (the `FILE_STORE` Durable Object)
owns the catalog, revision manifests, upload intents, and quota. Keys use
`files:v1/{ownerId}/{fileId}/{revisionId}` (`fileBlobKey` in
`packages/worker/src/files/object-keys.ts`); a live collaboration checkpoint is
`{key}/yjs`. Account export pages these keys through `section: "r2_object"` from
`FileStore.inventory` (`collectAccountR2Inventory`). Account deletion calls
`FileStore.purge`, which deletes external-provider objects, then prefix-deletes
`files:v1/{ownerId}/` in `FILE_BLOBS` before clearing catalog state.

- Bucket names: `kody-file-blobs` (production), per-preview
  `{worker}-file-blobs` buckets created and cleaned up by
  `tools/ci/preview-resources.ts`, and the test env reuses the preview-style
  name locally.

RepoSession `@cloudflare/shell` Workspace objects above the inline threshold
(~1.5 MiB) live in `REPO_SESSION_BLOBS`. This is session scratch, not a
user-visible rewrite of repo files: the 10 MiB per-file policy still rejects
oversized writes, and Artifacts remains the durable source. Workspace keys use
`repo-session:{durableObjectId}/` (`{name}/{namespace}{path}`). `Workspace.rm`
deletes listed keys while SQL metadata exists; `purgeSession` prefix-purges
after `deleteAll` so a failed `rm` cannot orphan objects. Discard marks the
catalog row discarded, then prefix-purges. Expired-session cleanup prefix-purges
before dropping the catalog row so a failed R2 delete keeps the row for cron
retry. A missing catalog row is not ownership proof, so discard and cleanup do
not wipe. Isolated check/rebuild RepoSession isolates never write this
workspace. The bucket is omitted from DR canonical exports and from the
`r2_object` account-export section.

- Bucket names: `kody-repo-session-blobs` (production), per-preview
  `{worker}-repo-session-blobs` buckets created and cleaned up by
  `tools/ci/preview-resources.ts`, and the test env reuses the preview-style
  name locally.

## Durable Objects (`MCP_OBJECT`)

MCP server runtime state is hosted via a Durable Object class (`MCP`) in
`packages/worker/src/mcp/index.ts`, exposed through the `/mcp` route.

- The Worker forwards authorized MCP requests to `MCP.serve(...).fetch`
- Durable Objects provide a stateful execution model for MCP operations
- The DO is keyed by the MCP SDK session id (per-connection); per-user identity
  is supplied on every request via the OAuth token's `props`
  (`McpCallerContext.user`) rather than baked into the DO id.

## Durable Objects (`JobManager` and `StorageRunner`)

Jobs use two Durable Object roles across workers:

- `JobManager` (jobs worker): one object per user, responsible only for alarm
  scheduling and dispatching due jobs from `JOBS_DB`-backed metadata
- `StorageRunner` (runtime worker): one object per durable storage id,
  responsible for isolated SQLite state that can be bound to execute calls,
  jobs, and dedicated storage inspection capabilities

Each `JobManager` alarm processes at most `maxDueJobsPerAlarm` due jobs
(`packages/shared/src/jobs/repo.ts`, oldest `next_run_at` first). When more due
jobs remain after a run, the post-run alarm resync arms a near-immediate
follow-up alarm so large backlogs drain across multiple short invocations
instead of one Durable Object wake.

Storage split:

- `JOBS_DB` `jobs` table: job metadata, persisted caller context, schedule
  fields, `last_run_at` / `last_run_status` as retention anchors, repo source
  pointers (`source_id`, `published_commit`), and stable `storage_id`. Terminal
  run error, duration, counters, and pruned execution history live in the
  per-user `RunLog` (`job_run_observability` and `runs`; see
  [Run records](../run-records.md))
- `JobManager` SQLite: only alarm bookkeeping needed to wake the right user's
  due jobs
- `StorageRunner` SQLite: isolated durable state addressed by `storageId`

`user_storage_buckets` inventories both StorageRunner buckets and RepoSession
workspaces for the check-only `storage_bytes` baseline. Rows use `kind` to
dispatch `getEstimatedBytes` to the correct Durable Object, cache the latest
`databaseSize` in `estimated_bytes`, and feed the same bounded
`storage_bucket_estimate_backfill` lane. Index-backed repo-session
reconciliation pages `repo_session_due_owners` with a per-tick owner budget and
a platform-owned `repo_session_storage_bucket_cursor` so a sweep cannot walk the
whole fleet. Repo sessions register on open, opportunistically refresh after
workspace mutations, and remove the inventory row on discard, purge, scheduled
cleanup, source deletion, or account deletion. This estimate component is
composed with the authoritative UserMeter D1 payload bytes; it is not reserved
into UserMeter.

Package delete clears every package-owned bucket before removing the package
row. For leftover `package:<uuid>` rows whose package row is gone (soft-deleted
packages still count as present, and so do ids a community fork reserves),
`adminOrphanPackageStorageCleanup` previews them by default and, with
`apply: true`, runs the same per-bucket clear. It is admin-only and audited.

## Durable Objects (`UserMeter`)

Daily rate-style entitlement counters and inbound email delivery-id idempotency
live in a per-user `UserMeter` Durable Object with SQLite
(`packages/worker/src/entitlements/user-meter-do.ts`). Schema v4
`storage_bytes_state` is the **authoritative** storage-byte counter (see
[Entitlements](../entitlements.md#usermeter)). The Worker binding is
`USER_METER` (class `UserMeter`; Wrangler SQLite migration tag `v21` via
`new_sqlite_classes` in `packages/worker/wrangler.jsonc`).

Naming matches `RunLog` and `JobManager`: one object per untrimmed stable MCP
`userId` via `userMeterDurableObjectName(userId)` → `idFromName(userId)` in
`packages/worker/src/user-scoped-durable-object-name.ts`. There is no `user_id`
column inside the DO because the object identity is the user.

SQLite ownership (schema version tracked in `user_meter_meta`; current version
**14**):

- `daily_counters` — authoritative UTC-day counters for `email_sends_per_day`,
  `email_receives_per_day`, `execute_unique_workers_per_day`,
  `outbound_fetches_per_day`, `job_runs_per_day`, and
  `automation_invocations_per_day` (`resource`, `day`, `count`, monotonic
  `revision`, `updated_at`).
- `inbound_delivery_claims` — idempotency ledger keyed by inbound `delivery_id`
  (scoped by DO identity, so the primary key is delivery id alone). Records the
  claim's resource/day, post-charge counter, revision, and `claimed_at` so
  Cloudflare Email Routing retries inside the 48-hour inbound dedupe window
  cannot double-charge `email_receives_per_day`.
- `storage_bytes_state` — **authoritative** D1 payload byte counter (`id = 1`
  CHECK constraint, `bytes`, monotonic `revision`, `updated_at`). Written by
  `reserveStorageBytes` (atomic increment with limit check),
  `initializeStorageBytes` (INSERT OR IGNORE cold bootstrap / zero-init
  fallback), and `setStorageBytes` / `reconcileStorageBytes` (absolute set from
  reconcile). Authoritative for enforcement and usage reads via
  `readStorageBytes`; cold bootstrap seeds from the physical D1 sum via an
  immediate per-owner reconcile enqueue, and the reconcile lane sweeps personal
  and team org owner ids by keyset from `d1_storage_reconcile_cursor`.
  StorageRunner and RepoSession bucket estimates stay outside this row (see
  [Entitlements](../entitlements.md#usermeter)).
- `deletion_state` / `account_write_leases` — deletion tombstone plus write
  leases (singleton `deleting_at`; lease rows `token` / `holder` / `acquired_at`
  / `pending_repair_id`). Schema v8 is authoritative for all leases. All callers
  supply `USER_METER`. D1 `account_write_lease_repairs` is the repair audit log
  and `users.deleting_at` remains the permanent point gate. `purge()` preserves
  an existing deleting tombstone across `deleteAll` while cleanup still has a D1
  user row. After that row is deleted, origin clears the tombstone so the purged
  object keeps no state. Account export emits a sanitized `deletionState`
  without raw token/holder.
- `dynamic_worker_days` — first-seen Dynamic Worker ids per UTC day
  (`worker_id`, `day`, `created_at`; PK `(day, worker_id)`). Used to emit one
  `dynamic_worker_day` usage event per unique Cloudflare bill unit, and to
  classify observe-only `dynamic_worker_invoke` as hit or miss. Not an
  entitlement counter and not included in `exportCounters`.
- `execute_call_days` — admitted hosted execute calls per UTC day (`day` PK,
  `count`), repeats included. Feeds the daily `execute` usage trend; the plan
  cap counts unique workers in `daily_counters` instead.
- `budget_spend_state` / `budget_spend_users` — this month's org budget spend
  (automation total and per-member micro-USD) for real-time budget checks.
- `inbound_mcp_connection_last_used` — last successful MCP bearer validation per
  inbound OAuth `clientId` (`client_id` PK, `last_used_at`). Account →
  Connections joins this as last-used next to Revoke.
  `ON CONFLICT … WHERE last_used_at < cutoff` debounce writes to five minutes.
  Not time-pruned; revoke and `purge()` remove the row. Account export emits
  `inboundConnectionLastUsed` on the first `exportCounters` page only.

Retention is self-enforced inside the DO: every read/write path
opportunistically deletes counter, inbound-claim, unique-worker-day, and
execute-call-day rows older than fourteen UTC days
(`userMeterDailyCounterRetentionDays`). Enforcement only needs the current day;
the window covers timezone edge cases, recent account exports, and inbound
retries. Storage-byte state is not time-pruned. Write-lease rows clear on
release/repair/purge.

**Daily counter authority:** enforcement, point reads, bootstrap, and account
export/deletion paths use `UserMeter`; D1 has no daily entitlement counter table
or day index. `adminUserMeterParity` reports meter-only daily counts.
`readDailyTrend` returns one compact RPC of daily counters, unique-worker-day
counts, and execute-call counts for that retention window;
`readAccountUsageTrend` / `usageTrendGet` zero-fill missing days and attach a
cheap `usage_rollups` monthly series. See
[Entitlements](../entitlements.md#usermeter).

**Daily cold bootstrap:** a missing `(resource, day)` row returns
`needs_bootstrap`. The service calls `initialize({ count: 0 })` with
`INSERT OR IGNORE` (concurrent callers stay safe). Warm daily paths never read
D1 for enforcement.

Account deletion calls `UserMeter.purge()` (one RPC per user, no D1 id scan;
`deleteAll` clears counters, claims, storage bytes, write leases, and inbound
MCP last-used rows while preserving an existing deleting tombstone during
cleanup). After the D1 user row is removed, origin drops that tombstone so the
purged object keeps no state. A later signup with the same email gets a new
random `stable_user_id` and never reattaches to the deleted account's storage.
Account export pages `UserMeter.exportCounters` through the `user_meter`
manifest section / `accountExportSection` (daily counters plus authoritative
`storageBytesState`, sanitized `deletionState`, and `inboundConnectionLastUsed`
on the first page only when present).

## Durable Objects (`Mailbox`)

User-owned email **metadata** lives in a per-user `Mailbox` Durable Object with
SQLite (`packages/worker/src/email/mailbox-do.ts` and siblings under
`mailbox-*.ts`; client in `packages/worker/src/email/mailbox-client.ts`). The
Worker binding is `MAILBOX` (class `Mailbox`; Wrangler SQLite migration tag
`v22` via `new_sqlite_classes` in `packages/worker/wrangler.jsonc`). Raw MIME
and outbound attachment bytes stay in `EMAIL_BLOBS` R2; the DO stores object
keys, not payload bytes. Canonical key builders live in
`packages/worker/src/email/blob-keys.ts`.

Naming matches `RunLog`, `JobManager`, and `UserMeter`: one object per untrimmed
stable MCP `userId` via `mailboxDurableObjectName(userId)` →
`idFromName(userId)` in
`packages/worker/src/user-scoped-durable-object-name.ts`. Data rows have no
`user_id` column (object identity is the user). Because a Durable Object cannot
introspect its `idFromName` string, a singleton `mailbox_owner_identity` row
persists `ownerId` on first write and rejects cross-owner RPCs. That persisted
owner is also used to validate canonical owner-scoped R2 keys (`emailRawMimeKey`
/ `emailAttachmentBlobKey`).

**SQLite ownership** (schema version in `mailbox_meta`; current
`mailboxSchemaVersion = 5`):

- `mailbox_owner_identity` — singleton `owner_id` for blob-key validation and
  cross-user write rejection
- `email_threads`, `email_messages`, `email_attachments`, and
  `email_delivery_events` for the owning user
- `email_outbound_provider_index_repairs` for accepted sends whose operational
  D1 reverse-index write still needs retry
- latest per-message delivery status on `email_messages.delivery_status`, kept
  separate from send-request `processing_status`
- warm-safe additive inbound-ledger due-work indexes, effect leases, retention
  state, and message-deletion tombstones; cold objects install the full DDL and
  warm objects apply guarded additive schema updates.

**USER authority:** live, scheduled, admin, and account USER paths read and
write the owner Mailbox only. Inbound raw MIME is written to R2 first, then
`commitInboundMessageGraph` validates the active `storageLease` and writes the
thread, message, and attachments in one DO SQLite transaction. Only after that
commit does the delivery transition to `received`. Preclaim bounded rejections,
stale-delivery reconciliation, usage/subscription effect leases, classification,
explicit delete, export, and retention are Mailbox operations.

Outbound USER requests write their graph to Mailbox before provider submission.
After provider acceptance, terminal message/event persistence is retried in
Mailbox. D1 `email_outbound_provider_index` is the only USER email
graph-adjacent runtime table: it is a thin, independently idempotent
`providerMessageId → ownerId/messageId/inboxId` lookup. Contextless provider
webhooks resolve that index and mutate Mailbox; they never join shared D1 graph
tables. The terminal Mailbox transaction also records a pending provider-index
repair. Immediate D1 synchronization clears it on success; the Mailbox alarm
retries failures with bounded backoff and publishes aggregate repair health.

USER write entry points require the permanent `email_user_graph_authority`
marker and fail closed when it is absent. The marker retains `owner_count`,
`frozen_at`, and `dropped_at` as the graph-drop contract. D1
`email_inbound_due_owners` provides bounded owner discovery for scheduled
inbound reconciliation, ordered by due time and owner with 25 owners processed
per tick. `email_delivery_alert_events` preserves short-lived bounced/complained
signals for operator burst alerts. Static import/SQL architecture checks reject
production D1 references to USER graph table names; those tables exist only in
owner-scoped Mailbox SQLite.

For operator mail, `system_email_threads`, `system_email_messages`,
`system_email_attachments`, and `system_email_delivery_events` are the only live
metadata and inbound-ledger authority for `system:email`. Reads never fall back
to shared `email_*` rows, and the reserved owner never gets a Mailbox Durable
Object. Shared inbox/address/sender configuration remains in D1 because the
dedicated graph references that operator configuration; account export/deletion
continues to exclude the reserved owner.

Every authoritative system graph or inbound-ledger mutation writes only the
dedicated tables and commits with the dedicated authority/provider-link guard.
R2 retention deletes all referenced blobs first, then atomically deletes
dedicated metadata. If any blob delete fails, the authoritative row remains for
retry. Scheduled retention selects age/cap/events/orphan threads only from the
dedicated graph.

The admin mailbox maintenance `status` action reports content-free dedicated
counts, authority marker state, invalid-reference count, and provider-link
count. It has no graph parity or reconcile action.

The detached `email_outbound_provider_index` does not accept `system:email`.
System outbound sends and provider-linked dedicated messages remain unsupported.
Runtime marker checks repeat the provider gate so any provider-linked system row
stops dedicated work.

**USER restore boundary:** Mailbox/R2 is the only USER graph authority. Recovery
must quiesce email writers and restore the authoritative Mailbox and
`EMAIL_BLOBS` backups; the verified historical D1 bookmark is disaster-recovery
evidence, not a serving-source switch.

**Mailbox graph contract:** all live USER RPCs are owner-bound. Complete graph
writes validate canonical owner-scoped R2 keys. Inbound graph commits
additionally validate the active storage lease, delivery/message identity, inbox
identity, and expected attachment count in the same SQLite transaction as the
graph write. Outbound terminal message/event updates are one SQLite transaction.
Read, classification, explicit-delete, export, and effect-ledger RPCs reject
cross-owner access and do not fall back to D1. Users delete their own stored
messages with `emailMessageDelete` or the delete action on `/@<slug>/-/email`,
both of which call owner-bound `deleteMessageWithBlobs` and then drop any
`email_outbound_provider_index` row for that message.

**Retention** is self-enforced inside the DO with alarms
(`mailboxMessageRetentionDays = 365`, `mailboxDeliveryEventRetentionDays = 90`).
Alarm-driven deletes derive canonical blob keys from `ownerId` + row ids (rather
than trusting stored key strings), then apply strict blob-before-row ordering
for `EMAIL_BLOBS` (failed blob deletes skip the row for retry). Each alarm or
owner-bound `runRetentionNow({ ownerId })` invocation selects and revalidates at
most one R2-backed message inside one safe concurrency gate; queued live writes
run before a continuation turn can select another message. SQLite-only expired
delivery-event and orphan-thread cleanup remains batched at 100 rows. Successful
work with expired rows remaining schedules a near-immediate continuation
(`mailboxRetentionContinuationDelayMs`). An R2 failure writes a durable
per-message hourly `retry_at` (`mailboxRetentionRetryDelayMs`); candidate
selection skips that message until due, so a failing oldest message cannot
head-of-line block newer eligible candidates. Alarm scheduling chooses the
earliest eligible continuation, retry due-time, or ordinary future retention
due-time. Write-path alarm selection never postpones an earlier existing alarm
under sustained writes (near-equal times within skew keep the existing alarm).
`alarm` and the RPC share natural production cutoffs and the same post-pass
alarm reschedule; the RPC returns before/after `countMailbox` aggregates plus
`blobDeleteFailures` / `expiredRemaining` (no row ids or content).

**Admin maintenance** is audited and content-free outside an explicitly
owner-scoped delete. Fleet status reports the USER authority marker, thin
provider-index structure, pending provider-index repair owners, inbound due
owners, delivery-alert health, and dedicated system-email counts/reference
health. USER retention calls `Mailbox.runRetentionNow`; USER explicit delete
inventories and deletes canonical R2 keys, deletes Mailbox metadata, and
idempotently removes any thin provider-index row. The dedicated `system:email`
maintenance path remains D1-backed.

USER retention returns Mailbox before/after counts (no message ids or email
content).

Account deletion uses one owner-bound Mailbox object (no shared-graph D1 id
scan). Before purge it exhaustively pages `listBlobReferences`, deletes those
canonical keys and the defensive `EMAIL_BLOBS` owner prefixes, and aborts on any
inventory or cleanup warning. Only then does it call `Mailbox.purge()` (result
key `mailboxes`). Purge clears DO SQLite/alarm state and reinitializes schema;
it does **not** delete R2 objects. Account export pages the sole authoritative
USER graph through the `mailbox` section (`exportMailbox` / `countMailbox`) and
uses `listBlobReferences` for USER email R2 bytes.

### What stays in D1

- **Operator system-email inbox** — remains permanently in D1 for cross-account
  admin access, fixed bounded caps, and separate system-email retention. The
  dedicated `system_email_*` graph is authoritative and stays excluded from
  account deletion and export (`accountOperatorOwnedD1Surfaces`). Operator mail
  always remains outside per-user Mailbox objects.
- **Low-write email config** — sender identities, inboxes, inbox addresses,
  sender rules, and similar low-churn configuration stay in D1.
- **Provider-message reverse lookup** — outbound Cloudflare sending webhooks
  resolve owner/message through the operational D1 lookup table
  `email_outbound_provider_index`, keyed by `(provider, provider_message_id)`
  with `user_id`, `message_id`, `inbox_id`, and created/updated timestamps
  (indexes on `user_id` and unique `message_id`). Mailbox
  `email_messages.provider_message_id` is authoritative. The index `message_id`
  is an opaque owner-scoped key with no graph foreign key. Mailbox
  explicit/account deletion removes index rows separately and idempotently.
  Outbound send separates provider acceptance, bounded Mailbox terminal
  persistence, and independently retryable index persistence; an index failure
  never requests a resend. A pending repair is durable in owner Mailbox SQLite,
  retried by its alarm with bounded backoff, and summarized in D1 without
  provider/message identifiers. Account export omits the operational reverse
  index (`includeInExport: false`); exported Mailbox messages retain their
  provider ids, but no fleet-wide automatic rebuild is claimed.
  `recordProviderEmailDeliveryEvent` resolves index-first, then loads the
  owner-scoped Mailbox message (no shared-message scan). System outbound is
  unsupported, and the verified `no-system-provider-links` disposition means
  `system:email` rows are never added to this global index. The admin status
  exposes an index-only structural report. Contextless provider-id reverse
  lookups must not enumerate per-user Mailbox objects.

### Inbound durability boundary (USER Mailbox authority)

For USER mail, the owner-bound Mailbox ledger is the lifecycle/effect authority:

1. Mailbox CAS selects the dedupe winner. UserMeter consumes quota for that
   winner, then Mailbox inserts the charged pending snapshot.
2. R2 stores raw MIME before metadata commit.
3. `commitInboundMessageGraph` validates the active storing lease and writes
   thread/message/attachments atomically in owner SQLite.
4. Mailbox CAS finalizes the delivery as `received` or `rejected`; terminal
   effects run under Mailbox leases.

Retries and stale reconciliation inspect Mailbox state only. Preclaim bounded
rejection audits are written directly to Mailbox. No live reverse bridge,
projection, or shared-D1 graph fallback exists.

`system:email` is the explicit exception: its inbound lifecycle, effects, and
reconciliation use the dedicated D1 graph and never bootstrap a Mailbox.

If R2 succeeds but the fenced graph transaction or finalization fails, Email
Routing retries the stable delivery id. The graph transaction is idempotent and
the active lease prevents a stale worker from overwriting the winner.

### Package and repo state model

Repos are the durable home for versioned Artifacts source; saved packages are an
explicit extension that adds publish semantics and runtime surfaces. Plain repos
live in `user_repos` with `entity_sources.entity_kind = 'repo'`. Packages add
`saved_packages` plus `entity_sources.entity_kind = 'package'`.

Package and plain-repo state maps onto storage homes as follows:

- **Package source** — Cloudflare Artifacts repos + D1 `entity_sources`
  projections; `package.json` is authoritative.
- **Package config** — D1 and secret rows keyed by the saved package id
  (manifest metadata and package-scoped secrets).
- **Package storage** — StorageRunner bucket
  `package:{encodeURIComponent(packageId)}` via `buildPackageStorageId` /
  `packageStorage()`. Shared durable data and non-secret knobs for every package
  surface.
- **Package jobs** — schedule metadata in `JOBS_DB` `jobs`; run-local scratch in
  `job:package-job:{packageId}:{encodeURIComponent(jobName)}`; shared durable
  data in package storage.
