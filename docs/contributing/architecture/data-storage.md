# Data storage

## Contents

- [Per-user isolation invariant](#per-user-isolation-invariant)
- [Account deletion inventory](#account-deletion-inventory)
- [Account export inventory](#account-export-inventory)
- [D1 (`APP_DB`)](#d1-app_db)
- [D1 (`JOBS_DB`)](#d1-jobs_db)
- [Analytics Engine reporting](#analytics-engine-reporting)
- [KV (`OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`)](#kv-oauth_kv-bundle_artifacts_kv)
- [R2 (`COMMUNITY_ASSETS`, `EMAIL_BLOBS`, `REPO_SESSION_BLOBS`)](#r2-community_assets-email_blobs-repo_session_blobs)
- [Durable Objects (`MCP_OBJECT`)](#durable-objects-mcp_object)
- [Durable Objects (`JobManager` and `StorageRunner`)](#durable-objects-jobmanager-and-storagerunner)
- [Durable Objects (`UserMeter`)](#durable-objects-usermeter)
- [Durable Objects (`Mailbox`)](#durable-objects-mailbox)
- [Per-user Durable Object naming](#per-user-durable-object-naming)
- [Per-user runtime context (no shared `globalThis`)](#per-user-runtime-context-no-shared-globalthis)
- [Configuration reference](#configuration-reference)
- [Repo-backed source and Artifacts](#repo-backed-source-and-artifacts)
- [Frozen storage contract inventory](#frozen-storage-contract-inventory)

This project uses several Cloudflare storage systems for different purposes.

## Per-user isolation invariant

Kody is multi-user with strict per-user isolation. Every user-owned storage
layer described below is scoped by `user_id` (D1 columns, Vectorize metadata, KV
key prefixes, Durable Object names), and every owner read/write path takes a
`userId` argument. Two users with the same logical identifier (for example the
same MCP server name, the same package id, or the same storage id) land on
different durable objects and different rows. Any new persistence layer added to
the project must follow the same convention; user-scoped tests should exercise
both the "happy" path and a cross-user denial path.

The deliberate storage exception is **operator-owned system email** for reserved
platform local parts (`kody`, `support`, `abuse`, `postmaster`, `security`,
`admin`, and `psl`). The permanent D1 tables are `system_email_threads`,
`system_email_messages`, `system_email_attachments`, and
`system_email_delivery_events`. They omit `user_id` because the operator owner
is implicit. They are the sole live `system:email` graph authority. The reserved
id is not a login account and must not be conflated with the `kody@example.com`
fixture or Kent's personal account. Account deletion and export treat these
tables as platform/operator content in `accountOperatorOwnedD1Surfaces`, with
guardrail tests.

Platform feedback remains user-owned and user-scoped in storage, but has a
narrow cross-user read and triage path. Only feedback the submitting user
explicitly approved enters that role-gated admin surface. The stored submitter
id makes feedback attributed rather than anonymous; the exception never grants
admins access to unrelated account data.

Community forks and ratings remain user-owned rows for deletion and export, with
a narrow role-gated admin metadata projection. It joins those rows only to
public listing identity and the actor's username. Fork rows snapshot the public
listing name and package name leaf so retained provenance remains intelligible
after a listing is deleted. The projection never reads the forked Artifacts
source, the public snapshot file tree, rating notes, or unrelated account data.
Actor usernames resolve through the unique `users.stable_user_id` index; email
and stable user ids remain absent from activity results and events. One-click
installs and ordinary forks share the same row shape and therefore appear as
`fork`.

## Account deletion inventory

Account deletion is implemented in `packages/worker/src/app/account-deletion.ts`
and is intentionally inventory driven. Before inventory it durably sets
`users.deleting_at`; browser, MCP, package-invocation, and job mutation
boundaries then reject writes, while the deletion route can still authenticate
the marked account for retry. Before any destructive step it settles billing:
for every `active` or `trialing` subscription it first refunds the unused
remainder of the current period, then cancels; `past_due`, `unpaid`, `paused`,
and `incomplete` subscriptions are canceled without a refund. The refund lists
the subscription's ten most recent paid invoices and walks them newest first to
the first one that took money and has a positive line whose service `period`
covers `now` (the newest paid invoice can be a
$0 downgrade proration with
nothing to give back). For every such line it computes
`floor(lineAmount * (period.end - now) / (period.end - period.start))` in the
smallest currency unit and issues one Stripe credit note with a
`lines[n]` entry per line, `refund_amount` set to the previewed credit-note
total, `reason=order_change`, the memo
`Prorated refund for unused time after account deletion`,
`metadata.kody_account_deletion=1`, and `metadata.kody_subscription_id`. The
invoice line's `amount` is gross (before promotion-code discounts and exclusive
tax), and Stripe prorates each line's discounts and tax into the credit note, so
the previewed total — not the raw fraction — is what the customer gets back.
The refund is capped at `amount_paid` minus every issued credit note already on
the invoice (any issuer, paginated to the end), because an upgrade invoice nets
a positive new-plan line against a negative old-plan credit; a preview above the
cap is scaled down by `cap / previewedTotal` and previewed again, up to six
times (see [`entitlements.md`](./entitlements.md#account-deletion-refunds)).
Nothing is refunded when no paid invoice covers the period (an unconverted
trial, or only past periods), every amount floors to zero, the cap is zero or
less, the preview totals zero (a fully discounted line), or Stripe reports the
invoice's charge already refunded in full. Two edge cases skip the refund
without blocking the deletion, each audited as `account` /
`account_deletion_refund_skipped` / `failure`: a scaled preview that still
exceeds the cap after every pass (reason `unfittable:${currency}:${cap}`,
logged as `account_deletion_refund_unfittable`), and an invoice whose credit
note listing is too long to trust. That second skip records reason
`credit_notes_incomplete:${invoiceId}`. It logs `account_deletion_refund_credit_notes_incomplete`.
An under-counted listing would over-refund.

Any other Stripe rejection — including a credit amount Stripe says exceeds what
is creditable, which means Kody's math disagrees with the invoice — raises
`AccountDeletionBillingError`, matching a failed cancel. The marker is released
and the account is retained (like an inventory failure) so the customer is never
billed for an account that no longer exists and never loses a refund silently.
Retries are idempotent: already-canceled or missing subscriptions count as
canceled, and an invoice that already carries an issued credit note with the
`kody_account_deletion=1` metadata marker (the memo alone never counts) is
reported but not refunded again. Each newly issued refund is audited as
`account` / `account_deletion_refund` with reason `${currency}:${amountMinor}`
(hashed email only). The deletion result carries `stripeRefunds`
(`subscriptionId`, `amountMinor`, `currency`, `invoiceId`, `creditNoteId`) so
the delete route can show the amount to the user. After cancelling, the
customer's credit notes are listed and every issued Kody-marked note is added,
so a retry still reports refunds an earlier attempt issued for subscriptions
that are no longer billable. Stripe customer deletion stays a best-effort
warning after cleanup. The operation then performs idempotent out-of-band and
OAuth cleanup. Any critical cleanup failure preserves D1, the marker, and the
user row for retry. Only after cleanup succeeds does one atomic D1 batch delete
or clear all user rows and the `users` row. Each step records deleted counts,
updated counts for cleared references, and warnings so the HTTP response states
what was removed and what needs operator attention. Re-running the operation is
safe: missing rows, missing KV keys, missing vectors, deleted Artifacts repos,
and already-cleared Durable Objects are treated as successful no-ops or
warning-only failures.

All four dedicated `system_email_*` graph tables are intentionally excluded from
account deletion. They are operator-owned mail for reserved platform addresses,
not portable user content. The scheduled system-email lane applies its 90-day
age policy, 5,000-message cap, and blob-before-row deletion against the
dedicated authority.

Platform-feedback rows follow two account-deletion behaviors. Deleting the
submitting account deletes its submissions. When a deleted account was an admin
reviewer for another user's surviving submission, deletion clears the reviewer
reference so the row does not retain attribution to a nonexistent account.

Deletion must cover these user-owned surfaces:

- **D1:** every live table with `user_id` / `*_user_id` ownership columns, plus
  transitive children (`secret_entries`) and listing children for
  community-owned listings. The guardrail test in
  `packages/worker/src/account/data-targets.node.test.ts` applies the live
  migrations to SQLite and fails if a user-owned schema column lacks schema
  coverage in the runtime target list or if that list references a stale column.
- **Durable Objects:** `JobManager`, `StorageRunner`, `RepoSession`,
  `RepoSessionIndex`, `PackageRealtimeSession`, `McpClientHub`, `RunLog`,
  `UserMeter`, `StripePlanRefresh`, and `Mailbox` are purged through
  account-deletion RPCs after their identifiers are collected (`RunLog`,
  `UserMeter`, `StripePlanRefresh`, `Mailbox`, and `RepoSessionIndex` are one
  object per user and need no D1 id scan). Account deletion first captures the
  authoritative USER raw-MIME and attachment references through
  `Mailbox.listBlobReferences`, deletes those owner-safe R2 keys plus defensive
  owner-prefix sweeps, and only then calls `Mailbox.purge()`. The purge clears
  DO SQLite only (see [Mailbox](#durable-objects-mailbox)). `MCP` objects remain
  SDK session-keyed, while `mcp_agent_sessions` indexes each Durable Object id
  by authenticated stable user id so account deletion can purge stored props,
  conversation state, raw-fetch state, and transport storage before revoking
  OAuth grants.
- **Vectorize:** memory, job, and saved-package vector ids are derived from D1
  rows and removed with `deleteByIds`. Each surface in
  `accountUserOwnedVectorizeSurfaces` declares its row source: memory and
  saved-package ids come from `APP_DB` tables, while job ids come from the jobs
  worker over the `JOBS` binding (`listJobIdsForUser`, live plus archived job
  ids) because `APP_DB` has no `jobs` table (ADR 0016). Inventory fails rather
  than skipping when `JOBS` is unbound. Matching `vector_embed_fingerprints`
  rows are deleted by `vector_id` on those writes; account deletion clears
  remaining rows for that `user_id`.
- **R2:** raw USER email MIME and attachment blobs in `EMAIL_BLOBS` are
  inventoried by `Mailbox.listBlobReferences`; the Mailbox store derives raw
  keys from owner/message ids and emits only canonical external-attachment keys.
  Deletion also performs per-user prefix cleanup (`email-raw:v1:{userId}/` and
  `email-attachment:v1:{userId}/`) as defense in depth. A failed inventory or
  object delete aborts Mailbox purge and D1 finalization, preserving the
  deletion marker and Mailbox rows for retry. Rows owned by `system:email` keep
  their blobs here (they are not user data); those blobs are removed when
  system-email retention deletes messages through the D1 helper.
  `Mailbox.purge()` never deletes R2 objects. RepoSession workspace spill in
  `REPO_SESSION_BLOBS` is ephemeral scratch keyed by Durable Object id
  (`repo-session:{durableObjectId}/`). Account deletion enumerates session ids
  and each `purgeSession` prefix-purges that object's keys after `deleteAll`.
- **KV:** published bundle artifact keys, source/manifest snapshot keys,
  community listing snapshots, per-user package retriever cache/index keys,
  package-skills index keys, package codemod revert keys, and MCP OAuth
  refresh-family snapshot/replay keys
  (`derived-cache:v1:mcp-oauth-refresh-{family,replay}:{userId}:`) in
  `BUNDLE_ARTIFACTS_KV` are deleted before D1 projection rows are removed. OAuth
  token/grant KV is owned by the OAuth provider and is handled through provider
  grant revocation rather than app-level key scans.
- **Cloudflare Artifacts:** source repos referenced by `entity_sources` and the
  per-user `RepoSessionIndex` catalog are deleted through the REST client in
  `packages/worker/src/repo/artifacts.ts`.

## Account export inventory

Account export is implemented in `packages/worker/src/account/export.ts`. It
mirrors the deletion inventory so portability and account migration cover the
same user-owned storage surfaces. The D1 table list and shared kind→SQL match
builders live in `account/data-targets.ts` (`accountUserDataTargets`,
`buildUserScopedTargetMatch`); export redaction columns also live there. Org and
person hard purge share that inventory through `hardPurgeDataTargets` in
`orgs/data-targets.ts` (`person` is `accountUserDataTargets`). Team org hard
purge collects the same out-of-band keys account deletion collects for the owner
id (`purgeOwnerOutOfBandSurfaces`), deletes those objects, then deletes D1 rows
including owner-scoped inventory without `deleted_at` (for example
`published_bundle_artifacts`). Personal org hard purge (org id == person id) is
org-graph only so the following user purge can still inventory those keys.
`SOFT_DELETE_PURGE_ENABLED` stays `false`, so the purge lane dry-runs.
Out-of-band surfaces (Durable Objects, KV schemes, R2, Vectorize, Artifacts) are
declared in `user-owned-surfaces.ts` and consumed by both deletion and export.
Growth-table retention dispositions are linked in
`account-retention-dispositions.ts`.
`packages/worker/src/account/export.node.test.ts` applies the live migrations to
SQLite and fails if a `user_id` / `*_user_id` column is not covered by the
export list. The hard invariant is the same as every storage path: callers pass
the authenticated user's stable MCP `userId`, and every query or Durable Object
lookup is scoped to that id.

Dedicated `system_email_*` rows are intentionally absent from account exports
for the same reason they are absent from deletion: they belong to the operator
inbox surface, not to the exporting user. The export manifest lists the
omissions under `excludedD1Surfaces` so they are explicit. Daily entitlement
counters live only in `UserMeter`, so they do not appear in the D1 inventory or
`excludedD1Surfaces`.

Platform-feedback submissions are included in the submitting user's own D1
export section. An export never includes submissions owned by other users,
including feedback the exporter may have reviewed as an admin. The submitter's
feedback status and submitter-visible resolution fields (`resolution_note`,
`resolution_pr_urls`) may remain in the export, but internal review metadata
(`reviewed_by_user_id`, `reviewed_at`, and `admin_note`) is redacted.

Exports are versioned JSON documents:

- `manifest.schemaVersion` — `1`.
- `manifest.generatedAt` — UTC timestamp.
- `manifest.sections` — per-section counts, warnings, and redacted columns.
- `manifest.security.secretValuesExported` — always `false`.
- `d1` — user-scoped D1 rows grouped by table. USER email graph rows are
  exported only through the authoritative Mailbox section.
- `durableObjects` — exported user-scoped Durable Object state where it is
  durable and enumerable.
- `oauthGrants` — OAuth grant metadata only.
- `artifactRepos` — Artifacts repo pointers from `entity_sources`.
- `kvKeys` — KV source/cache keys that belong to the user.

Secret values are **never** exported. `secret_entries` rows are metadata-only:
name, description, bucket, allowed hosts, allowed kody, allowed packages, and
timestamps. The encrypted payload (`encrypted_value`) and lookup hash
(`lookup_hash`) are omitted. The same redaction rule is applied to other
credential-equivalent fields such as password hashes and password/email reset
token hashes. The manifest states these redactions explicitly so a partial or
intentionally redacted export is not mistaken for a complete secret backup.

The browser route `GET /account/export.json` downloads a bounded metadata
manifest for the signed-in user and identifies the MCP capabilities required for
a complete export. It deliberately does not inline D1 rows, Durable Object
state, or R2 bytes. The MCP capability domain `account` provides the complete,
migration-safe chunked interface:

- `accountExportManifest` returns the manifest, counts, warnings, and chunking
  instructions.
- `accountExportSection` pages through one section at a time. D1 rows are read
  with `section: "d1_table"` and a table name. Durable storage buckets are read
  with `section: "storage_runner"` and a `storage_id`, using the same
  StorageRunner `exportStorage({ pageSize, startAfter })` RPC as the dedicated
  storage export capability. User meter counters use `section: "user_meter"` and
  the `UserMeter.exportCounters` RPC (daily counters plus authoritative
  `storageBytesState`, sanitized `deletionState`, and
  `inboundConnectionLastUsed` on the first page only when present). Mailbox
  metadata uses `section: "mailbox"` and the `Mailbox.exportMailbox` RPC. R2 raw
  MIME, attachment, avatar, and icon objects use `section: "r2_object"`; each
  response contains at most one 256 KiB base64 chunk and an opaque cursor. Each
  request uses bounded `LIMIT 1` ownership queries rather than reconstructing
  inventory. Continuation cursors bind the source row, object key, size, and
  ETag; ownership/key mutations and object overwrites are reported instead of
  mixing generations. Missing objects are represented explicitly. R2 cursor
  version 1 is unsupported by the current Mailbox-authoritative traversal
  because translation could duplicate bytes; callers must restart the
  `r2_object` section without `startAfter`.

D1 manifest counts use bounded SQL `COUNT(*)` queries. D1 section rows are read
with SQL-level keyset pagination: every query orders by the table's `rowid`,
resumes strictly after an opaque cursor, and applies a SQL `LIMIT`, so a single
query never loads a whole table. `accountExportSection` fetches only the
requested page.

Durable Object export behavior:

- `StorageRunner` bucket contents are exported with paged entries. These buckets
  hold application and job durable state and are the primary account migration
  surface for Durable Object storage.
- `JobManager` exposes scheduler alarm/debug state through an export RPC.
- `RunLog` exports per-user execution history (runs + log lines), the keyed
  package-invocation idempotency ledger, and dedicated RunLog state (workflow
  projections, job-run observability, package run successes, activation
  milestones) through the account-export `run_records` section (`exportRuns`
  RPC; one cursor pages runs first, then ledger rows, then each dedicated phase
  via prefixed cursors). Run history self-prunes inside the DO (~30 days / 2,000
  runs; ledger terminal rows 90 days). Terminal workflow projections age-prune
  after 90 days inside the DO; job/activation dedicated tables are never pruned
  by retention. D1 has no workflow, package-success, or activation projection
  tables. The restore bookmark for the D1 schema that predates their removal,
  database `8c1014d1-6b41-4695-a0a2-159071f0f919`:
  `0000116d-000000d2-000050bd-c7ecd5892a189df7cda145af746bc9c9`. See
  [Run records](./run-records.md).
- `UserMeter` exports daily entitlement counter rows through the `user_meter`
  section (`exportCounters` RPC; keyset pagination by UTC `day` and `resource`).
  The same RPC returns authoritative `storageBytesState`, sanitized
  `deletionState`, and `inboundConnectionLastUsed` on the first page only
  (`startAfter` absent; `null` on later pages). Section totals count each state
  inventory once when present. The storage-byte counter lives only in UserMeter.
  Retention is self-enforced inside the DO (fourteen UTC days of counter and
  inbound-delivery-claim rows); storage-byte state is not time-pruned. See
  [Entitlements](./entitlements.md#usermeter).
- `Mailbox` is the sole authoritative USER email graph export. It exports
  threads, messages, attachments, and delivery events through the account-export
  `mailbox` section (`exportMailbox` RPC; keyset pagination with prefixed
  cursors); manifest counts use `countMailbox`. No shared USER D1 graph exists,
  so the D1 export contains no duplicate email metadata. USER R2 export
  enumerates raw MIME and attachment keys with `Mailbox.listBlobReferences`.
  Internal `email_message_retention_retries` rows defer failed R2 deletion
  attempts without blocking other expired messages; they are likewise excluded
  from export/counts and removed with message or mailbox purge. See
  [Mailbox](#durable-objects-mailbox).
- `MCP`, `RepoSession`, `PackageRealtimeSession`, and `McpClientHub` remain
  account-export exclusions: MCP objects are SDK session-keyed and not globally
  enumerable; RepoSession is an ephemeral editing workspace (although its SQLite
  plus `REPO_SESSION_BLOBS` spill bytes are inventoried for the `storage_bytes`
  entitlement); PackageRealtimeSession is live websocket state; McpClientHub can
  hold OAuth tokens and SDK registrations that are non-portable. Canonical
  repo-backed source and durable package app state are covered by Artifacts
  pointers and StorageRunner buckets instead.

Vectorize entries are intentionally excluded. Memory text and metadata, job
metadata, and package projections are exported from D1; vectors are derived and
should be rebuilt by reindexing after import. `vector_embed_fingerprints` is the
same class of derived skip cache and is omitted from portable export.

Cloudflare Artifacts repo contents are not inlined in the JSON export. D1 stores
metadata/projections, while canonical package, job, and app source lives in the
Artifacts repos referenced by `entity_sources.repo_id` and the
`RepoSessionIndex` catalog `source_repo_id`. For account migration to a new
Cloudflare account, first run `accountExportManifest`, page through export
sections as needed, then separately fetch or clone every repo listed in
`artifactRepos` using Artifacts access and recreate those repos in the
destination account before importing D1 projections or republishing packages.

## D1 (`APP_DB`)

Relational app data lives in D1.

TEXT `user_id` (and `owner_user_id`) columns hold an `OwnerId`: the org that
owns the row. Every owner is a personal org whose id is the person's
`stable_user_id`, so the column names stay as they are. Columns that record who
acted hold a `PersonId`. Both types come from
`@kody-internal/shared/owner-person-ids.ts`; see
[decision 0060](../decisions/0060-owner-and-person-ids.md).

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
  `orgs` row (see `orgs` below and [Entitlements](./entitlements.md)).
  Pre-signup attribution lives in the last-wins one-week `kody_ref` cookie.
  `referrals` stores the signup-time row (`referrer_stable_user_id`,
  `referee_stable_user_id`) and the invoice-gated reward ledger (`status`,
  `reward_invoice_id`, held invoice fields while email is unverified). See
  [Entitlements](./entitlements.md#referral-pro-credit). The
  `d1_storage_reconciliation` lane sweeps live owners (personal orgs by
  `users.stable_user_id` and team orgs by `orgs.id`) in one keyset from the
  platform-owned `d1_storage_reconcile_cursor` singleton. UserMeter
  `storage_bytes_state` (schema v4) drives storage-byte enforcement; see
  [Entitlements](./entitlements.md#usermeter). Inbound email routing does not
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
  [decision 0063](../decisions/0063-teams-expand-orgs.md).
- `handles` (0086): the username namespace. Handles are permanent (no username
  or org slug renames); rows left by pre-rule renames stay reserved.
- `org_memberships` (0086): `(org_id, user_id)` with role `owner`, `member`, or
  `billing`. Signup writes the person as Owner of their personal org.
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
- Workflow, activation, and package-success state lives in dedicated RunLog
  tables; D1 has no corresponding projection tables (see
  [Run records](./run-records.md)).
- There is no `jobs` table in `APP_DB` — it lives in the jobs worker's `JOBS_DB`
  (see [D1 (`JOBS_DB`)](#d1-jobs_db)). `archived_job_artifacts` was dropped from
  `JOBS_DB`.
- There is no `repo_sessions` table in `APP_DB` (dropped in migration `0013`).
  The catalog lives in the per-user `RepoSessionIndex` Durable Object. D1 keeps
  only the thin `repo_session_due_owners` hint and the platform-owned
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
  from export. See [MCP Events](../../guides/mcp-events.md) and
  [0059](../decisions/0059-mcp-events-extension-behind-flag.md).
- `community_listings`, `community_forks`, `community_ratings`,
  `community_reports`, `community_bans`: public package listings and moderation
  (see [Public packages](../community-packages.md)). `community_forks` rows for
  a saved package are removed on package delete (`packageDelete` / account
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
  endpoints, and flow options. See [OAuth integrations](./integrations.md).
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
  [OAuth integrations](./integrations.md#platform-built-in-oauth-apps).
- `platform_provider_marks` (`0035-platform-provider-marks.sql`): operator-owned
  brand marks for saved integrations, keyed by `slug`, with no `user_id`.
  `aliases_json` holds extra provider keys and authorize hosts. `logo_key` /
  `logo_content_type` point at a fitted WebP in `COMMUNITY_ASSETS` under
  `platform-provider-marks/{slug}/`. Display uses these after an explicit upload
  and before auto-favicon. See
  [OAuth integrations](./integrations.md#provider-logos).
- `user_integrations` (squashed baseline, rebuilt by
  `0004-platform-oauth-apps.sql`): per-user OAuth connections keyed by
  `(user_id, name)`. Exactly one of nullable `app_slug` (composite FK
  `(user_id, app_slug) → user_oauth_apps(user_id, slug)`) or nullable
  `platform_app_slug` (FK to `platform_oauth_apps(slug)`) is set, enforced by a
  `CHECK` constraint; both FKs use `ON DELETE RESTRICT`. Holds `scopes_json`,
  `required_hosts_json`, `usage_mode` / `allowed_packages_json`, and access /
  refresh token ciphertext. The non-secret `client_id` is stored inline on the
  owning app row.

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
[ADR 0016](../decisions/0016-mono-worker-extraction.md) and the
[jobs worker migration runbook](./jobs-worker-migration-runbook.md).

- `jobs`: persisted package job metadata, caller context, schedule state,
  package source pointers, and optional `expires_at` (UTC ISO; when reached the
  scheduler skips the job and auto-disables it with `enabled = 0`). Every row id
  is a `package-job:` id (asserted by migration `0004`, ADR 0032). Rows are
  created, updated, and removed by package publish sync, package deletion, and
  account deletion; `expires_at` stops scheduling only — it does not delete
  rows. This database keeps schedule fields (`next_run_at`, `schedule_json`, …)
  and `last_run_at` / `last_run_status`; terminal run error, duration, and
  counters for observability live in the per-user `RunLog`
  `job_run_observability` table (see [Run records](./run-records.md)).

## Analytics Engine reporting

The role-gated admin insights page reads its 28-day email volume and outbound
delivery-outcome charts from the `EMAIL_EVENTS` Analytics Engine dataset.
Workflow status totals and activation funnel/latency on the same page come from
**bounded, content-free per-user RunLog point reads** (see
[Run records — Admin insights RunLog reads](./run-records.md#admin-insights-runlog-reads)),
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
  [Usage metering](./usage-metering.md#usage-campaign).
- `agent_package_conversation_uses` records per-user package conversation
  cardinality from MCP `execute` package paths. That path stays on D1 because it
  is latency-sensitive relative to Analytics Engine SQL. A per-user meter
  Durable Object is a possible future home if D1 write contention requires
  another move. MCP server instructions do not read this table.

## KV (`OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`)

OAuth provider state is stored in `OAUTH_KV` through the
`@cloudflare/workers-oauth-provider` integration. Published package source
snapshots, bundle artifacts, package retriever caches, and community listing
snapshots are stored in `BUNDLE_ARTIFACTS_KV`. That binding also holds the
platform-owned `platform-settings:v1:reserved-usernames` runtime
reserved-username override and short-lived encrypted MCP OAuth refresh-family
snapshots (`derived-cache:v1:mcp-oauth-refresh-family:` /
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

## R2 (`COMMUNITY_ASSETS`, `EMAIL_BLOBS`, `REPO_SESSION_BLOBS`)

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
  name locally (Wrangler/vitest-pool-workers simulate the bucket).

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
  [Run records](./run-records.md))
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

## Durable Objects (`UserMeter`)

Daily rate-style entitlement counters and inbound email delivery-id idempotency
live in a per-user `UserMeter` Durable Object with SQLite
(`packages/worker/src/entitlements/user-meter-do.ts`). Schema v4
`storage_bytes_state` is the **authoritative** storage-byte counter (see
[Entitlements](./entitlements.md#usermeter)). The Worker binding is `USER_METER`
(class `UserMeter`; Wrangler SQLite migration tag `v21` via `new_sqlite_classes`
in `packages/worker/wrangler.jsonc`).

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
  [Entitlements](./entitlements.md#usermeter)).
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
[Entitlements](./entitlements.md#usermeter).

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

## Per-user Durable Object naming

The Durable Objects whose state is intrinsically owned by one user are named so
that two different users always resolve to two different object ids. Builders
live in `packages/worker/src/user-scoped-durable-object-name.ts` (JSON tuples
via `durableObjectNameFromParts`); domain helpers such as
`durableObjectNameFromParts` delegate to that module.

- `JobManager` — `jobManagerDurableObjectName(userId)` → `idFromName(userId)`.
- `RunLog` — `runLogDurableObjectName(userId)` → `idFromName(userId)`. One
  execution-history DO per user; there is no `user_id` column inside it because
  the DO identity is the user. Hosts pruned run history, the invocation ledger,
  and dedicated state (workflow projections with 90-day terminal retention,
  job-run observability, package activation counters/milestones). See
  [Run records](./run-records.md).
- `UserMeter` — `userMeterDurableObjectName(userId)` → `idFromName(userId)`. One
  daily-entitlement meter DO per user (untrimmed stable id, same as `RunLog`)
  with authoritative schema-v4 storage-byte state. See
  [Entitlements](./entitlements.md#usermeter).
- `StripePlanRefresh` — `stripePlanRefreshDurableObjectName(userId)` →
  `idFromName(userId)`. One ephemeral, one-shot reconciliation alarm per user;
  checkout and subscription webhook activity arm it as a backstop to the
  immediate Stripe refresh. Account deletion cancels and purges the alarm.
- `Mailbox` — `mailboxDurableObjectName(userId)` → `idFromName(userId)`. One
  email-metadata DO per user (untrimmed stable id, same as `RunLog`). See
  [Mailbox](#durable-objects-mailbox).
- `McpClientHub` — `mcpClientHubDurableObjectName(userId)` →
  `idFromName(userId.trim())`.
- `StorageRunner` — `storageRunnerDurableObjectName(userId, storageId)` →
  `idFromName(JSON.stringify([userId, storageId]))`.
- `PackageRealtimeSession` —
  `packageRealtimeSessionDurableObjectName({ userId, packageId })`.
- `RepoSessionIndex` — `repoSessionIndexDurableObjectName(userId)` keyed by
  untrimmed `userId` (like RunLog / UserMeter / Mailbox). Authority for the
  per-user session catalog: rows, active counts, conversation resume, export,
  and deletion inventory. Each index self-alarms; D1 keeps only the thin
  `repo_session_due_owners` hint (one row per user with any session) plus the
  platform-owned storage-bucket inventory cursor.
- `RepoSession` — `repoSessionDurableObjectName(sessionId)` keyed by session id
  only (not user-prefixed). Every RPC validates the catalog row's `user_id`
  before touching the workspace. Account deletion enumerates the user's session
  ids from `RepoSessionIndex` and purges each workspace DO. Documented exception
  to user-scoped naming.
- The `MCP` Durable Object is addressed by MCP session id rather than user id;
  ownership is enforced at the request boundary by validating the authenticated
  user against the `McpCallerContext` on every request.

## Per-user runtime context (no shared `globalThis`)

Kody `execute` calls and package-app worker entrypoints store the current
request's runtime in an `AsyncLocalStorage` shared between the wrapper and the
`capabilities:runtime` virtual module via `Symbol.for('kody.runtimeStorage')`.
Two concurrent calls in the same isolate observe their own runtime view through
the ALS rather than racing on a shared mutable `globalThis` slot. See
`packages/worker/src/package-runtime/module-graph.ts`,
`packages/worker/src/mcp/run-kody-registry.ts`, and
`packages/worker/src/package-runtime/package-app.ts` for the wrapper
implementations, and
`packages/worker/src/package-runtime/runtime-isolation.node.test.ts` for the
concurrent two-runtime test that pins this invariant.

`capabilities:runtime` is also a host-external package-runtime module. Saved
package bundle artifacts reserve `.__kody_virtual__/runtime.js` import paths but
strip the runtime source before persistence. Execution loaders hydrate those
paths with the deployed host runtime source for every package surface (exports,
subscriptions, jobs, package apps, workflows, and ad hoc execute). Static
`kody:@...` package imports remain pinned snapshots, while literal dynamic
`import("kody:@...")` is permanently unsupported. Publish checks reject the
pattern, and runtime rewriting returns a teaching error that names static
imports and `import(specifier)` as the supported alternatives.

## Configuration reference

Bindings are configured per environment in `packages/worker/wrangler.jsonc`
(names and bindings only; remote D1/KV IDs come from deploy-generated configs).
`JobManager` and `JOBS_DB` live on the jobs worker
(`packages/jobs-worker/wrangler.jsonc`); the main worker reaches them through
the `JOBS` service binding. Runtime Durable Objects (`StorageRunner`, `RunLog`,
`PackageRealtimeSession`) live on the runtime worker and are bound cross-script
from origin — see [ADR 0016](../decisions/0016-mono-worker-extraction.md).
Platform Durable Objects (`MCP`, `McpClientHub`, `OAuthPurgeCoordinator`,
`UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`)
live on the platform worker and are bound cross-script from origin and runtime —
see [ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md). The origin
script owns no Durable Object classes.

- `APP_DB` (D1)
- `AUDIT_DB` (D1, global hashed security audit trail)
- `JOBS` (service binding to the jobs worker `JobsService` entrypoint)
- `OAUTH_KV` (KV)
- `BUNDLE_ARTIFACTS_KV` (KV)
- `EMAIL_BLOBS` (R2, raw email MIME blobs)
- `OPERATOR_BACKUPS` (R2, operator rollback snapshots such as org resource
  transfer backups)
- `REPO_SESSION_BLOBS` (R2, ephemeral RepoSession Workspace spill; not a DR
  canonical store)
- `MCP_OBJECT` (Durable Objects; class hosted on the platform worker)
- `RUN_LOG` (Durable Objects; per-user run records — see
  [Run records](./run-records.md); class hosted on the runtime worker)
- `USER_METER` (Durable Objects; per-user daily entitlement counters — see
  [Entitlements](./entitlements.md#usermeter); class hosted on the platform
  worker)
- `STRIPE_PLAN_REFRESH` (Durable Objects; per-user, activity-driven Stripe plan
  reconciliation alarms; class hosted on the platform worker)
- `MAILBOX` (Durable Objects; sole per-user email graph, inbound-ledger,
  retention, read, export, and mutation authority — see
  [Mailbox](#durable-objects-mailbox); class hosted on the platform worker)
- `STORAGE_RUNNER` (Durable Objects; class hosted on the runtime worker)
- `REPO_SESSION` (Durable Objects; class hosted on the platform worker)
- `REPO_SESSION_INDEX` (Durable Objects; per-user repo session catalog hosted on
  the platform worker. The runtime worker binds this class cross-script so
  package and workflow capability calls can open, list, and publish repo
  sessions.)
- `PACKAGE_REALTIME_SESSION` (Durable Objects; class hosted on the runtime
  worker)
- `MCP_CLIENT_HUB` (Durable Objects; user-added remote MCP servers — see
  [MCP client servers](./mcp-client-servers.md); class hosted on the platform
  worker)
- `OAUTH_PURGE_COORDINATOR` (Durable Objects; class hosted on the platform
  worker)
- `COMMUNITY_ASSETS` (R2; community listing assets)
- `CAPABILITY_VECTOR_INDEX` (Vectorize; capability/memory/job/package vectors)
- `ASSETS` (static assets bucket)
- `USAGE_EVENTS` (Analytics Engine dataset, production/preview only; see
  [Usage metering](./usage-metering.md))
- `EMAIL_EVENTS` (Analytics Engine dataset, production/preview only; indexed by
  stable user id and read only through role-gated platform aggregates)
- `MCP_PROTOCOL_EVENTS` (Analytics Engine dataset, production/preview only; one
  point per authenticated `/mcp` request recording which protocol lane served it
  (sessionful Durable Object vs stateless SDK) and, on `tools/call`, blob8
  package-identity param class (`kody_id` / `package_id` / `name` / `both` /
  `none`); see `packages/worker/src/mcp/protocol-metrics.ts`)
- `EXECUTE_INTERPRETABLE_EVENTS` (Analytics Engine dataset, production/preview
  only; one point per MCP execute-tool module classifying whether it is
  interpretable pure glue for fleet `q`; see
  [Usage metering](./usage-metering.md#execute-interpretable-share-q))
- `MCP_SEARCH_EVENTS` (Analytics Engine dataset, production/preview only; one
  point per MCP `search` call with wall clock, exclusive-tile remainder, and
  intent/trim signals; see
  [Usage metering](./usage-metering.md#mcp-search-duration))
- `ONBOARDING_FUNNEL_EVENTS` (Analytics Engine dataset, production/preview only;
  one best-effort point per onboarding stage, indexed by stable user id, no
  prompts or secrets; admin insights reads unique users for 7 and 28 days. See
  [Usage metering](./usage-metering.md#onboarding-funnel))

`packages/worker/wrangler.jsonc` also configures the `EMAIL` send binding,
dispatch queues, worker loaders (`LOADER` / `APP_LOADER`), the `AI` binding, and
`DYNAMIC_CALLABLE_WORKFLOWS`; the Wrangler config is authoritative.

## Repo-backed source and Artifacts

Repo-backed saved packages, package apps, and jobs use Cloudflare Artifacts
repos plus D1 `entity_sources` rows and a per-user `RepoSessionIndex` catalog.

- Primary code lives under `packages/worker/src/repo/`.
- `entity_sources` stores the durable mapping from
  `(user_id, entity_kind, entity_id)` to the repo identity and last published
  commit.
- `RepoSessionIndex` stores mutable editing-fork catalog rows for repo session
  Durable Objects. D1 does not hold catalog rows.
- Published source snapshots and bundle artifacts are stored in
  `BUNDLE_ARTIFACTS_KV` and keyed by `source_id` plus `published_commit`.

Canonical source contract:

- Published repo source is the only canonical source for saved packages, package
  apps, and jobs.
- D1 keeps metadata and projections only. It does not store canonical package
  export code, app backend code, or job code.
- App rows keep display metadata, parameters, visibility, `has_server_code`, and
  `source_id` for app projections.
- Job rows keep scheduling/execution metadata, params, storage id, caller
  context, repo check policy, `source_id`, and the published commit last synced
  into the job projection.
- Saved package rows keep display/search metadata, tags, app availability, and
  `source_id` for Kody search and package discovery.
- Projection updates are made from published repo state by the publish/reindex
  paths; stale D1 inline source fields are not a fallback.

Operational notes:

- Saved packages are the user-facing repo-backed identity. They resolve through
  D1 metadata to `entity_sources.id` when a repo editing session is opened.
- `source_id` is the internal durable join key for repo-backed packages, but
  most MCP callers should prefer package identity with `repoOpenSession` and the
  file-level session capabilities (`repoEditFiles`, etc.).
- Once repo-backed source exists, the repo snapshot is the durable source of
  truth for later edits and publishes. Search and detail payloads are derived
  projections of that repo-backed source rather than a competing second source
  of truth.
- Repo sessions expose a file-level API inside the RepoSession Durable Object:
  batch edits (`repoEditFiles`: write/replace/writeJson/delete/move; same-path
  content edits compose in order), unified diff apply (`repoApplyPatch`), git
  inspection (`repoStatus`, `repoDiff`, `repoLog`), commit (`repoCommit`), and
  restore (`repoRestore`). There is no git-command parser channel;
  branch/checkout/remote operations require the Artifacts git lane via
  `packageGetGitRemote`. Package runtime bundles are loaded from published
  artifacts rather than a mounted checkout. The session Workspace spills objects
  above the inline threshold to `REPO_SESSION_BLOBS` so clone and checkout can
  honor the 10 MiB per-file policy without hitting the Durable Object SQLite 2
  MiB row limit.
- `repoEditFiles` `write` edits use the same Durable Object `applyEdits` write
  path for whole-file overwrites. Prefer a `write` edit over `repoApplyPatch`
  when the agent is replacing an entire file (for example, a single-file job
  source) instead of patching a hunk with surrounding context.

### Direct Artifacts git publishes

Saved package source can also be edited through Artifacts git remotes directly.
`packageGetGitRemote` resolves package identity to `entity_sources`, mints a
short-lived Artifacts repo token, and returns a plain remote, `git_author`
(signed-in account email and display name), and setup commands that pass the
token through `http.extraHeader` and set local `user.email` / `user.name` from
`git_author`.

After an external `git push`, `packagePublishExternalPush` reconciles the
current Artifacts default-branch HEAD with `entity_sources.published_commit`.
The RepoSession Durable Object clones that commit, checks that it is a
fast-forward unless `allow_force` is set, runs `runRepoChecks(...)`, and then
calls `publishFromExternalRef(...)`.

`publishFromExternalRef(...)` owns the post-receive publish transaction:

- run manifest, docs (`README.md` + `AGENTS.md`), dependency, bundle, typecheck,
  and lint checks before mutation
- write the `PublishedSourceSnapshot` and manifest snapshot to
  `BUNDLE_ARTIFACTS_KV` for the new commit (key is commit-scoped; previous tip
  keeps serving until the pointer moves)
- advance `entity_sources.published_commit` only after that KV write succeeds
- delete the never-advertised new snapshot key if the D1 pointer update fails
- rebuild saved package projections, bundle artifacts, vector search entries,
  retriever manifests, and package jobs through
  `refreshSavedPackageProjection(...)`

The same helper is used by the existing repo-session publish path after it has
pushed the session commit to the source Artifacts repo.

### Reconcile cron

`packages/worker/src/jobs/reconcile-artifacts-pushes.ts` is a safety net for
external pushes that were not followed by an explicit
`packagePublishExternalPush` call. In production, the `kody-jobs` cron trigger
(`packages/jobs-worker/wrangler.jsonc` `*/5 * * * *`) runs every five minutes
and sends each due maintenance lane to `kody-scheduled-dispatch`. Origin itself
has no cron trigger. The consumer is configured for one message per invocation
with independent concurrency, so a slow reconcile cannot consume the runtime
budget of retention, OAuth purge, or another sibling lane. Preview and local
runtimes execute the same registry inline when the production-only queue binding
is unavailable. A write-token mint sets the source's `external_check_until` to
the token expiry plus a one-hour grace period. The normal pass only scans these
pending sources, using `last_external_check_at` for the five-minute cadence and
keyset paging until the pending queue is drained or a wall-clock time budget
(`reconcileTimeBudgetMs`, ~60 seconds) is exhausted. Dormant package sources do
not incur an Artifacts HEAD lookup on every tick.

For each pending source, reconcile resolves the Artifacts default-branch HEAD.
When HEAD matches `published_commit`, it advances `last_external_check_at`
without any Durable Object work; once the token horizon has passed, that final
matching check also clears `external_check_until`. A successful explicit or
reconcile publish clears the pending horizon immediately. Unresolvable or
changed HEADs remain pending, and the RepoSession publish path is spun up only
when HEAD differs.

The reconcile loop is idempotent: if another caller publishes the same commit
first, the publish path returns `already_published`. Check failures and
non-fast-forward results leave D1/KV untouched and are counted in the one-line
metrics log, which also records batches processed and whether the time budget
was exhausted. Once per day during the 03:00 UTC cron window, reconcile also
widens the same keyset scan to every package source as a full-fleet backstop and
calls `revokeStaleArtifactsTokens(...)` for checked repos to clean up expired
Artifacts tokens.

Reconcile runs through the registry in
`packages/worker/src/scheduled/scheduled-lanes.ts`, alongside repo-session
cleanup, system-email retention, general retention, hourly usage-rollup
aggregation, hourly Durable Object duration attribution, and bounded USER
inbound Mailbox reconciliation (active-user discovery from the users/config
index followed by owner-point Mailbox due-work RPCs; no shared graph scan). Each
production queue message preserves `scheduled_lane_failed` / D1 lock-contention
log and Sentry context. D1 lock contention is replay-safe (the write did not
commit) and retries on `kody-scheduled-dispatch` with bounded backoff
(`max_retries` 3, then the dedicated DLQ plus a `scheduled_lane_retry_exhausted`
alert). Other handled lane failures are acknowledged as terminal so partial
external side effects are not replayed; the next eligible cron cadence is the
next automatic attempt. A failed enqueue is reported and runs through the inline
fallback after all sibling enqueue attempts finish; multiple failed enqueues
fall back sequentially to avoid D1 lock contention. Inline fallback is one-shot
and logs a non-completed outcome; it does not invent extra retries. Consumer
transport failures retain the configured retry/DLQ behavior. No failure can
abort or mask a sibling invocation.

`dlq_depth_alert` does not ride that queue: the cron calls it directly so a
stuck consumer cannot hide dead-letter backlog. Every five minutes it reads
Cloudflare queue metrics for each production dead-letter queue. A backlog that
has stayed non-empty for more than 15 minutes opens a Sentry issue (oldest
unacknowledged message, or the first non-zero sample when that timestamp is
missing). Operator Discord gets the issue from the existing Sentry alert
destination, the same path as the webhook auth regression alert. Non-production
runtimes skip the read. A failed metrics read fails the lane instead of
reporting the queue as empty. Inbound email subscription dead-letters are
terminal handler failures and are not part of this page.

Production note:

- Production deploys warn that the documented Artifacts Worker binding config is
  unexpected, and deploy logs show no `env.ARTIFACTS` binding in the deployed
  Worker binding summary.
- Because that binding is absent in production, repo source code uses the
  documented Artifacts REST API as the single integration path for
  create/get/token/fork operations.
- `packages/worker/src/repo/artifacts.ts` builds that REST client from
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and optional
  `CLOUDFLARE_API_BASE_URL` / `ARTIFACTS_NAMESPACE`, which also makes local dev
  mocking straightforward.
- During `npm run dev`, those REST calls go to the local Cloudflare mock Worker,
  which implements the Artifacts repo metadata endpoints used by the app
  (`create`, `get`, `list`, `createToken`, and `fork`). The mock only covers the
  REST control plane; repo session Durable Objects need a Git-capable remote for
  clone/pull/push flows.
- Durable repo-source creation paths
  (`ensureEntitySource(..., requirePersistence: true)`) fail closed when
  persistence bindings are unavailable so callers do not write orphaned
  `source_id` references into D1.

## Frozen storage contract inventory

This section records identifiers and serialized shapes that should be treated as
permanent unless a planned migration explicitly says otherwise. They are cheap
to document and expensive to discover after user data depends on them.

### D1 JSON shadow schemas

The following columns store JSON whose schema is defined in TypeScript rather
than in D1 constraints. Changes must be backward compatible on read and additive
on write unless a migration backfills existing rows.

- `jobs.params_json`, `jobs.schedule_json`, `jobs.caller_context_json`, and
  `jobs.repo_check_policy_json`
  (`packages/jobs-worker/migrations/0001-jobs-init.sql`,
  `packages/shared/src/jobs/repo.ts`) rely on parser and normalizer
  compatibility. Package jobs persist both `storageContext.appId` for value
  scope and `storageContext.packageId` for package-owned secret scope.
- `saved_packages.tags_json` and `community_listings.tags_json`
  (`packages/worker/migrations/0001-squashed-init.sql`) are `string[]`
  projections. `community_listings.category`
  (`0022-community-listing-category.sql`) is a closed browse category
  (`integrations`, `examples`, `productivity`, `apps`, `utilities`, or `other`).
  Publish copies `package.json#kody.category` when it is an author category.
  Missing or `other` falls back to well-known tag inference (examples, then
  integrations, productivity, apps) and otherwise stores `other`. The same
  inference backfills existing `other` rows in
  `0022-community-listing-category.sql`. Reads use the stored column so browse
  filters and chip counts stay aligned.
- `published_bundle_artifacts.dependencies_json` (`0001-squashed-init.sql`)
  stores package dependency pointers queried with SQLite JSON functions in
  `packages/worker/src/repo/published-bundle-artifacts-repo.ts`.
- Keyed invocation replay lives in the RunLog Durable Object ledger (see
  [Run records](./run-records.md)). D1 has no `package_invocations` or
  `package_invocation_tokens` table.
- `webhook_endpoints` (`0001-squashed-init.sql`,
  `0057-webhook-url-secret-encrypted.sql`,
  `0062-webhook-url-rotation-grace.sql`,
  `0072-webhook-hmac-secret-encrypted.sql`,
  `0127-webhook-hmac-rotation-grace.sql`) stores per-user minted URL state for
  `package.json#kody.webhooks`, keyed by `(user_id, package_id, webhook_name)`.
  URL secrets are SHA-256 hashed for ingress and AES-GCM encrypted
  (`url_secret_encrypted`) for server-side apply. Package-owned HMAC signing
  material lives on the same row (`hmac_secret_encrypted`) when verification
  omits `secretName`; provider-issued secrets use the secrets primitive via
  optional `verification.secretName`. Last-seen signing identity
  (`hmac_secret_name`) and a verification snapshot
  (`hmac_verification_secret_encrypted`) track declared-secret rotation;
  `previous_hmac_secret_*` holds the outgoing key for a 24h grace window (same
  duration as URL rotate overlap). MCP capabilities never return the plaintext
  URL or HMAC. Delivery history is recorded as `webhook` surface run records
  (see [Run records](./run-records.md) and [Inbound webhooks](./webhooks.md)),
  not as D1 rows.
- `system_email_daily_counters` (`0001-squashed-init.sql`) stores fixed
  per-local daily receive counters for operator-owned system inboxes. These
  counters are not user entitlements and are pruned by the system-email
  retention job.
- `mcp_memories.tags_json` and `mcp_memories.source_uris_json`
  (`0001-squashed-init.sql`) back memory search and provenance.
- `secret_entries.expires_at` (`0023-secret-entry-expires-at.sql`) is the
  optional per-secret UTC expiry the account UI and `secretSet` write. Session
  lifetime stays on `secret_buckets.expires_at`. Resolve and fetch placeholders
  treat an expired entry as missing; list and account views still show the row
  so it can be rotated. Effective remaining TTL is the earlier of entry and
  bucket expiry.
- `secret_entries.allowed_hosts` and `secret_entries.allowed_packages` are JSON
  string lists used as security policy inputs (`0001-squashed-init.sql`,
  `0032-drop-secret-allowed-capabilities.sql`). Tightening parse-error behavior
  requires explicit compatibility review. `allowed_packages` applies only to
  user-scoped secrets. Unadopted community-forked packages need it for every
  package read/use path (provenance via `community_forks.forked_package_id` +
  `forker_user_id`; index in `0001-squashed-init.sql`). Self-authored packages
  and adopted forks (`community_forks.adopted_at` / `adoption_note`) skip that
  grant for read/use only. Mutations from package code (`secretSet` /
  `secretDelete`) always require the grant. Only the account owner can add a
  package to that grant (secret editor or `/@<slug>/-/secrets/approve`).
  `secretLock` returns an approval URL and does not change `allowed_packages`.
  Removing a grant is website-only.
- `secret_provider_bindings` and `secret_provider_grants`
  (`0064-secret-provider-bindings.sql`) pin one saved package plus door-key
  secret name to a provider id per account, and grant saved packages use of a
  canonical `(provider, ref)`. Declaring `kody.secretProvider` is not a binding.
  Owners revoke grants on `/@<slug>/-/secret-providers`. Unbind, and rebind to a
  different provider package, drop grants (`ON DELETE CASCADE` from the
  binding). See [secret providers](../secret-providers.md). Official OAuth token
  rotation persists host-side and does not use that write grant. Authorship and
  adoption never imply a host allowlist. Package-scoped secrets are owned
  exclusively by the package id in their bucket binding.
- `user_oauth_apps.extra_authorize_params_json`,
  `user_integrations.scopes_json`, `user_integrations.required_hosts_json`, and
  `user_integrations.allowed_packages_json` (`0001-squashed-init.sql` /
  `0026-integration-owned-credentials.sql`, `packages/worker/src/integrations/`)
  store a string→string object, a scope string list, a host string list, and a
  saved-package-id list respectively. Parsers in the integrations data-access
  layer own the shapes. Access and refresh token ciphertexts live on
  `user_integrations`; the user-lane client secret ciphertext lives on
  `user_oauth_apps`. Those columns are the only credential store — there are no
  `*_secret_name` pointers and the values are not in `secret_entries`. Account
  export redacts the ciphertext columns.
- `provider`, `inject_json`, and `source_json` on `secret_entries`,
  `user_integrations`, `mcp_server_settings`, and `secret_provider_bindings`
  (`0111-credential-provider-inject-source.sql`) are the credential fields from
  [ADR 0068](../decisions/0068-credentials-own-placement-scoped-clients.md).
  `inject_json` is a header, basic, or query rule and defaults to
  `Authorization: Bearer {value}`. `source_json` is `"stored"`, or
  `{"vault": "<provider>"}` on a vault binding. An integration's `provider` is
  its OAuth app's provider, written on connect and backfilled by the migration.
  Request placement does not read them; placeholders still decide it.
- `secret_entries.kind` (`0117-credential-kinds.sql`) is the credential's kind
  from ADR 0068: `secret` (every existing row and the default), `url`, `login`,
  or `signing`. Placeholders fill only `secret` rows. A `url` value is a whole
  HTTPS URL that `resolveCredential` hands to the gateway only for one of the
  row's `allowed_hosts`; package code sends a relative path, never the URL.
- `secret_entries.config_json` (`0118-credential-login-config.sql`) is a `login`
  credential's exchange: an HTTPS URL on one of the row's `allowed_hosts`, the
  body template, and where the session token is in the response. Other kinds
  leave it NULL. The value holds the login fields as one JSON object, and
  `inject_json` places the session token. Sessions are kept per isolate, never
  in storage.
- `credential_inventory_runs` and `credential_inventory_items`
  (`0112-credential-inventory.sql`,
  `packages/worker/src/credentials/credential-inventory.ts`) hold the admin
  fleet inventory of credential placeholders in published package source.
  `adminCredentialInventoryScan` pages saved packages into a run; each item's
  `result_json` holds credential ids, placement shapes, slot providers, and
  placeholder counts (every placeholder, including ones that match a declared
  slot), never a credential name or value. Placement shapes may carry package
  identifiers (a body field, an SDK option key, a callee name) but never one
  that spells a credential name. A failed item holds only its load error, and
  the report lists failed package ids. `adminCredentialBackfill` reads a
  complete run with no failed packages (or whose failed packages the caller
  lists exactly in `acknowledgedFailedPackageIds`) and writes `provider` and
  `inject_json` only where they are still unset: `provider` when every slot
  naming the credential agrees on one provider slug, `inject_json` when every
  placement is the same header or the same query param.
- `credential_org_grants` (`0116-credential-org-grants.sql`,
  `packages/worker/src/credentials/personal-credentials.ts`) records which org
  each personal credential is granted to. `credential_id` is a credential in the
  owner's personal org, `user_id` is the owner's person id, and the row is
  hard-deleted when the owner leaves that org.
- `credential_mappings` (`0134-credential-mappings.sql`,
  `packages/worker/src/credentials/credential-mappings.ts`) stores which
  credentials one package need resolves to: the org-layer default (`target`
  `org`), one person's own default (`mine`, `person_user_id` set), or one
  trigger instance's override (`enablement`, `enablement_id` set and
  `person_user_id` the enabler). `credential_ids_json` is an ordered array of
  credential ids, and `[]` means "none on purpose". Rows hold ids only. A
  person's rows in an org are hard-deleted when they leave it, and with their
  account.
- `credential_mapping_proposals` (`0137-credential-mapping-proposals.sql`,
  `packages/worker/src/credentials/agent-credential-proposals.ts`) records each
  approvable `credentialMappingPropose` call under the agent that made it: the
  person (`person_user_id`) plus the request credential (`agent_credential_kind`
  and `agent_credential_id`, an MCP OAuth client, CLI client, or API token).
  When that person approves the link, `approved_picks_json` holds the trigger
  picks they approved, as credential ids; `credentialTriggerPickSet` lets the
  same agent set only those. Unapproved rows older than 30 days are dropped when
  that agent proposes again. A person's rows in an org are hard-deleted when
  they leave it, and with their account.
- `approval_bundles` and `approval_bundle_decisions`
  (`0144-approval-bundles.sql`, `packages/worker/src/approval-bundles/repo.ts`)
  store agent-prefilled approval pages (`approvalBundleCreate`). A bundle row
  names the person it is for (`person_user_id`), the agent credential that made
  it (`agent_credential_kind`, `agent_credential_id`), an untrusted note, and
  `items_json`, an ordered array of item keys (`publish:<requestId>`,
  `capabilities:<packageId>`, `credential-picks:<proposalId>`). Item state is
  read live from the item's own tables; a bundle holds no approval state. Each
  approve or deny first claims the item's decision row (`decided_by_user_id`),
  so one request acts per item, then sets `finalized_at`
  (`0145-approval-bundle-decision-finalized-at.sql`) when it is done. Until then
  the row is an in-flight claim, not a decision, and expires after 10 minutes.
  Within a bundle, the first finalized decision wins. Denying a capability set
  or credential proposal changes nothing, so it can still be approved from its
  own page or another bundle. Bundles open for 30 days. A person's bundles in an
  org are hard-deleted when they leave it, and with their account.

### Durable Object id contracts

`idFromName` inputs are Durable Object identity. Changing any of these strings
or tuple layouts creates new objects and strands existing object storage. All
builders are centralized in
`packages/worker/src/user-scoped-durable-object-name.ts` (plus
`durableObjectNameFromParts` in user-scoped Durable Object naming helpers, which
to `durableObjectNameFromParts`).

- `JobManager`: `idFromName(userId)` (no trim).
- `RunLog`: `idFromName(userId)` (no trim); one execution-history DO per user.
- `UserMeter`: `idFromName(userId)` (no trim); one daily-entitlement meter DO
  per user, plus authoritative schema-v4 storage-byte state.
- `StripePlanRefresh`: `idFromName(userId)` (no trim); one ephemeral billing
  reconciliation alarm DO per user.
- `Mailbox`: `idFromName(userId)` (no trim); one email-metadata DO per user.
- `RepoSessionIndex`: `idFromName(userId)` (no trim); one session-catalog DO per
  user.
- `McpClientHub`: `idFromName(userId.trim())`.
- `StorageRunner`: `idFromName(JSON.stringify([userId, storageId]))`.
- `RepoSession`: `idFromName(sessionId)`; the key is not user-prefixed, so every
  RPC must keep validating the catalog row's `user_id`.
- `PackageRealtimeSession`: `idFromName(JSON.stringify([userId, packageId]))`.
- `MCP`: session-keyed by the MCP SDK rather than by user id; OAuth caller
  context is the request-time ownership boundary and `mcp_agent_sessions`
  provides deletion-only enumeration by stable user id.

Storage ids are also stable strings. Changing a form strands the old bucket:

- `exec:{uuid}` — ad hoc execute storage bound on the call.
- `job:package-job:{packageId}:{encodeURIComponent(jobName)}` — package job run
  scratch (`job:{jobId}`; every job id is a package job id).
- `package:{encodeURIComponent(packageId)}` — package bucket behind
  `packageStorage()` / `buildPackageStorageId(packageId)`.
- `{packageId}:facet:{facetName}` — package-app facet StorageRunner buckets.
- `{packageId}:{exportName}:{name}` — package-app internal Durable Object
  namespace StorageRunner buckets.

### KV key contracts

`OAUTH_KV` is provider-owned by `@cloudflare/workers-oauth-provider`; do not put
app-owned keys in it. App-owned `BUNDLE_ARTIFACTS_KV` keys are:

- `source-snapshot:v1:{sourceId}:{publishedCommit}`.
- `source-manifest-snapshot:v1:{sourceId}:{publishedCommit}`.
- `bundle-artifact:v1:{sourceId}:{commit}:{kind}:{artifactName|_}:{entryPoint}`.
  Publish rebuild copies unchanged targets from the previous commit onto this
  new key (D1 identity row retargets) so a partial export bump does not leave
  the new `published_commit` missing artifacts.
- `community-snapshot:v1:{listingId}`.
- `package-retriever-manifest:v1:{userId}:{packageId}:{revision}`.
- `package-retriever-index-entry:v1:{userId}:{scope}:{packageId}:{retrieverKey}`
  for per-entry retriever index rows.
- `package-skills-index:v1:{userId}:{packageId}:{publishedCommit}` — per-version
  Agent Skills index (frontmatter + digests, no file contents) written at
  publish; served by Skills-over-MCP when `mcp-skills-extension` is on.
- `derived-cache:v1:mcp-oauth-refresh-family:{userId}:{grantId}` and
  `derived-cache:v1:mcp-oauth-refresh-replay:{userId}:{grantId}:{tokenHash}` —
  encrypted MCP OAuth refresh-family snapshots used so concurrent hosts sharing
  one client can reuse the previous refresh token without invalidating siblings
  (`packages/worker/src/oauth-refresh-family.ts`). Written with KV
  `expirationTtl` (two hours / one hour). Registered as user-owned KV surfaces
  and prefix-deleted by account deletion; the TTL covers a refresh that races
  deletion.
- `derived-cache:v1:usage-rollups:user:{userId}:asof:{YYYY-MM}` — derived
  per-user usage read model written with KV `expirationTtl`; retention is five
  minutes, so immediate account-deletion cleanup is not required.
- `derived-cache:v1:community-icon:v3:{listingId}:...` — derived community
  listing icon cache; registered as a user-owned KV surface and deleted for a
  user's listings during account deletion (including leftover
  `community-icon:v1` and `community-icon:v2` prefixes).
- `derived-cache:v1:identity-icon:v1:{repoId}:...` — derived repo/package list
  mark cache; registered as a user-owned KV surface and deleted for every
  `entity_sources.repo_id` during account deletion.
- `derived-cache:v1:artifact-head:v1:{namespace}:{repoId}` — default-branch HEAD
  (`{ branch, commit }`) of an Artifacts repo, read by package home, tree, and
  file pages instead of a live binding + REST + git `info/refs` chain
  (`packages/worker/src/repo/artifact-head-cache.ts`). Filled only by a page
  view (5 minute TTL, 1 hour stale-while-revalidate, 60 second TTL when HEAD is
  unresolved); a `cf.artifacts.repo.pushed` event to the cached default branch
  rewrites the commit from the payload, and a push to an unviewed repo writes
  nothing. Retention is the KV `expirationTtl`, so account deletion does not
  clean it up.
- `webhook-dispatch-payload:v1:{userId}:{deliveryId}` — ephemeral ack-mode
  webhook body spill written with KV `expirationTtl` (24 hours) when the
  serialized queue message would exceed 120 KB. Immediate account-deletion
  cleanup is not required because KV enforces the TTL; the queue consumer
  deletes the key after a terminal delivery.
- `platform-settings:v1:reserved-usernames` — platform-owned runtime reserved
  username override (`{ added, removed, updatedAt, updatedBy }`, where
  `updatedBy` is a stable user id). Not scoped by user id; account deletion must
  not remove it. The effective reserved token set is
  `(builtIn ∪ added) − removed`. `removed` cannot unreserve system-email locals
  or `kody`-prefixed built-in names. New username claims match that set
  case-insensitively by exact token or hyphen/underscore-stripped equality;
  compact substrings apply only to KV-added tokens and built-in brand/system
  roots (see [Security](../security.md)). When the key is missing or unreadable,
  signup-facing checks fail closed to the code-defined built-in list. Admins
  manage it from `/admin/reserved-usernames` and the `adminReservedUsernameList`
  / `adminReservedUsernameAdd` / `adminReservedUsernameRemove` capabilities.

Account deletion derives these keys from D1 rows and package ids before deleting
D1 projections. New KV prefixes must add corresponding account-deletion coverage
or a deliberate retention note.

### R2 key contracts

App-owned R2 keys are:

- `community-icon:v3/{listingId}/{commit}/asset` — processed public community
  icon bytes (256px WebP) at the listing's pinned or icon commit. The listing id
  is the public ownership boundary. Account deletion paginates and strictly
  deletes every key under each D1-owned listing prefix, including historical
  `community-icon:v1/` and `community-icon:v2/` revisions.
- `identity-icon:v1/{repoId}/{commit}/asset` — processed list/identity mark
  bytes (256px WebP) for a package or plain repo at its published or indexed
  commit. The Artifacts `repo_id` is the ownership boundary. Account deletion
  paginates and strictly deletes every key under each D1-owned repo prefix.

- `user-avatars/{stableUserId}/{contentHash}.{extension}` — profile avatars.
  Account deletion paginates and strictly deletes the complete stable-user
  prefix, including historical replacements left by earlier cleanup failures.

- `email-raw:v1:{userId}/{messageId}` — raw email MIME for the message row that
  stores this key in `email_messages.raw_mime_key`. Built by `emailRawMimeKey`
  in `packages/worker/src/email/blob-keys.ts`. The `userId` prefix is part of
  the per-user isolation contract; account deletion removes a user's blobs under
  the matching prefix (and any remaining inventoried keys).

- `email-attachment:v1:{userId}/{messageId}/{attachmentId}` — standalone
  attachment bytes (`storage_kind = 'external'`). Built by
  `emailAttachmentBlobKey` in `packages/worker/src/email/blob-keys.ts`. Same
  per-user prefix isolation and account-deletion coverage as raw MIME.

- `repo-session:{durableObjectId}/…` — ephemeral RepoSession Workspace spill in
  `REPO_SESSION_BLOBS`. Account deletion prefix-purges via each session Durable
  Object. This scratch is excluded from the `r2_object` account-export section;
  canonical repo bytes stay in Artifacts.

- `org-resource-transfers/{fromOrgId}/{toOrgId}/{stamp}-{uuid}.json` in
  `OPERATOR_BACKUPS` — rollback snapshot written by
  [org resource transfer](../org-resource-transfer.md) apply. Encrypted columns
  stay sealed. Account deletion and org hard purge delete every backup naming
  the owner as source or target; account export skips it because the same rows
  export from D1.

New R2 key prefixes must add corresponding account-deletion coverage or a
deliberate retention note, same as KV. Exportable registered R2 surfaces
(`EMAIL_BLOBS`, `COMMUNITY_ASSETS`) use the bounded `r2_object` account-export
section; the inventory is derived from the same user-owned D1 rows used by
account deletion. `REPO_SESSION_BLOBS` is registered R2 but is ephemeral session
scratch, so it is purged with the session instead of exported.

### Vectorize metadata contracts

Vector ids, namespaces, and metadata are conventional and require reindexing
when changed. User-owned vectors use the account's 64-character stable user id
as their Vectorize namespace. Builtin capability vectors use the reserved
`__kody_builtin__` namespace; stable user ids are lowercase SHA-256 hex, so the
reserved value cannot collide with an account. Namespace filtering is the
primary isolation boundary and is applied by Vectorize before search. The
`userId` metadata filter remains mandatory on every user-owned query as
defense-in-depth.

User-owned ids must also stay within Cloudflare Vectorize's 64-byte id limit:
builders first emit the legacy passthrough form when it fits, then fall back to
`{prefix}_sha256:{truncatedHexDigest}` for overlong raw ids. Length checks are
UTF-8 byte checks, not JavaScript string-length checks, and the digest form is
deterministic so upserts and deletes target the same vector.

- Memories: `memory_{memoryId}` in namespace `{userId}`, with metadata
  `{ kind: 'memory', userId, status, category? }`. Memory ids are UUID-like, so
  search parses only the passthrough `memory_` form back to the D1 id.
- Jobs: `job_{jobId}` or `job_sha256:{digest}` with metadata
  `{ kind: 'job', userId }` in namespace `{userId}`. Package-owned job ids
  `package-job:{packageId}:{jobName}` often need the digest form.
- Saved packages: `package_{packageId}` or `package_sha256:{digest}` with
  metadata `{ kind: 'package', userId }` in namespace `{userId}`.
- Builtin capabilities: id is the capability name in namespace
  `__kody_builtin__`, with metadata `{ kind: 'builtin', domain }`.

Search paths query only per-account namespaces plus the reserved builtin
namespace. Vector rows are derived from D1. User-owned memory, job, and
saved-package vectors upsert on write; saved packages also mark
`saved_package_search_index_debt` and reconcile after the response. Each upsert
(write-time or reindex) records a SHA-256 of embedding model, dimensions,
`vectorEmbedFingerprintVersion`, truncated embed text, and canonical Vectorize
metadata in `vector_embed_fingerprints` (`user_id` is the Vectorize namespace:
the account id, or `__kody_builtin__` for builtins). A later upsert with the
same hash skips Workers AI and Vectorize. Metadata is part of the hash so a
memory status or category change still rewrites the vector. `force: true` on the
maintenance body ignores fingerprints and rewrites Vectorize — required after
Vectorize data loss, because a D1 restore still has the skip rows, and after a
pooling-only embedding change (pooling is not in the hash). Bump
`vectorEmbedFingerprintVersion` when the metadata contract changes so hashes
invalidate even if embed text is unchanged. The bounded
`POST /__maintenance/reindex-capabilities` sweep rebuilds requested kinds
(`phases`; omit the field to rebuild every kind), keyset-pages memory, job, and
saved-package rows, rebuilds builtins in their reserved namespace, and returns
before a request-time budget. An incomplete sweep includes `complete: false` and
a `cursor` so the caller can POST again until `complete` is true. Production
deploy CI loops that endpoint with `{ "phases": ["capabilities"] }` after each
production ship so only builtin capability vectors refresh. A full sweep
(embedding-model change, metadata-contract change, or disaster recovery) omits
`phases` or lists every kind. Disaster recovery POSTs `{ "force": true }` so
restored fingerprints cannot skip an empty index.

### `entity_sources` and package import contracts

`entity_sources` is the durable repo pointer table:
`(user_id, entity_kind, entity_id) -> source_id`. Child tables store
`source_id = entity_sources.id`; KV snapshots use that same source id plus the
published commit. `entity_kind` accepts `package` and `repo`. `manifest_path`,
`source_root`, `published_commit`, `indexed_commit`, and
`last_external_check_at` are part of the repo-source synchronization contract
for packages; plain `repo` sources are live-at-HEAD, have no manifest
requirement, and are skipped by the external-push reconcile lane. Package-owned
jobs live in the package repo.

Saved package imports in user code use `kody:@scope/name/export` specifiers:

1. `packages/worker/src/package-runtime/package-import-resolution.ts` parses the
   `kody:@` prefix, the `@scope/name` package name, and an optional export
   subpath (default `.`).
2. Resolution is scoped to the caller's org. Ad hoc execute and saved packages
   must `communityFork` a package from another org (for example `@kody/github`
   from the `@kody` org) into the caller's org before importing or invoking it.
   No scope grants cross-org imports.
3. `packages/worker/src/package-registry/manifest.ts` normalizes export keys and
   resolves them through `package.json#exports`.
4. Static imports are pinned into bundle dependencies at publish time. Literal
   dynamic `import("kody:@...")` calls are permanently rejected by publish
   checks and rewritten to an actionable teaching error at runtime.

Do not change this grammar or static/dynamic distinction without a user-code
migration plan.

### Growth and retention policies

The Worker cron dispatcher runs every five minutes, but
`packages/worker/src/app/retention.ts` gates the general retention job to the
top of the hour. Production dispatches it as its own queue invocation; preview
and local runtimes run it inline. Each hourly run loops in round-robin passes
over the policy tables — every pending table gets one configured batch before
any table gets a second one — until every table is drained or the run's time
budget (`retentionRunTimeBudgetMs`, ~20 seconds measured with `Date.now`) is
exhausted. The first pass always completes so a hot table cannot starve the
others, and per-batch sizes stay small to bound D1 single-writer pressure.
Progress is reported with a one-line `retention-prune` log that includes
batches-per-table counts and whether the budget ran out. The retention module
owns the named constants and manifest, and
`packages/worker/src/app/retention.node.test.ts` fails if a future
growth-pattern D1 table is added without either a policy or a documented
exemption.

Current retention policies:

- `mcp_memory_conversation_suppressions`: keep active suppressions and prune
  expired rows only after they have not been seen for 90 days. The existing
  request-time memory prune may remove expired rows sooner.
- Terminal workflow projections age-prune after 90 days inside the per-user
  `RunLog` DO (`workflow_projections`; see [Run records](./run-records.md)).
- `published_bundle_artifacts`: delete D1 rows and their `BUNDLE_ARTIFACTS_KV`
  blobs only when the row is older than 30 days, its `published_commit` is no
  longer current for any matching `entity_sources` row, and there is no active
  repo session for the source. When a row is pruned, the matching
  `source-snapshot:v1:{sourceId}:{commit}` and
  `source-manifest-snapshot:v1:{sourceId}:{commit}` KV keys are deleted under
  the same safety conditions, so per-commit snapshots do not accumulate
  indefinitely. Ambiguous publish/edit cases are intentionally kept.
- Mailbox `email_delivery_events`: USER events keep 90 days under the per-owner
  DO alarm/admin RPC. System email is governed by the dedicated system-email
  retention job, which prunes messages, external attachment objects, raw-MIME
  blobs, and delivery events older than 90 days in parameter-bounded batches
  within its own time budget, deletes stale `system_email_daily_counters`, caps
  stored system messages at 5,000, and prunes orphan threads. All R2 objects are
  deleted before dedicated metadata; a failure preserves authority rows for
  retry. The four dedicated `system_email_*` tables therefore have explicit
  `alternate_cleanup` dispositions.
- Mailbox `email_messages` / `email_attachments` / `email_threads`: USER
  messages keep 365 days. The DO deletes canonical raw-MIME/external-attachment
  R2 objects before metadata and retries failures. It then prunes orphan
  threads. Derived provider-index cleanup is separately idempotent.
  `system:email` stays on the dedicated D1 retention job and has no
  provider-index rows.
- UserMeter daily counter rows keep fourteen UTC days
  (`userMeterDailyCounterRetentionDays`); `adminUserMeterParity` reports
  meter-only daily counts.
- `usage_rollups`: per user/metric/month rollups keep 24 months by `month` key;
  raw Analytics Engine usage events follow platform retention.
- `usage_connection_daily`: per org, UTC day, connection (credential kind,
  holder person, credential id), package, and event type. The hourly usage
  aggregation lane rewrites yesterday and today from Analytics Engine and prunes
  days older than 14. Deleted and exported with the account (`holder_user_id` is
  a person column).
- `user_usage_campaigns` / `user_usage_campaign_sends`: usage-state campaign
  machine and send ledger keyed by `stable_user_id`. `ever_activated` and
  `cooling_terminal` are sticky. Deleted and exported with the account. Durable
  until deletion; no TTL.
- `user_tips_email_opt_outs`: Kody tips opt-out stamp keyed by `stable_user_id`.
  Deleted and exported with the account. Durable until deletion; no TTL.
- `durable_object_duration_daily`: per-user, per-DO-class, per-UTC-day
  Cloudflare-measured active milliseconds (absolute; the hourly attribution lane
  rewrites yesterday and today). Deleted and exported with the account.
  `durable_object_duration_coverage_daily` is the fleet-level attributed vs
  total companion (no user data).
- `credit_wallets`: one prepaid credit wallet per owner id (`user_id` is the org
  id; personal orgs reuse `stable_user_id`). Balance in micro-USD, auto-refill
  settings and saved card id, notice opt-outs.
- `credit_ledger_entries`: append-only top-ups, auto-refills, admin grants (with
  `granted_by_user_id` and `note`), and debits. `stripe_reference` is unique for
  idempotent Stripe credits. Deleting an admin anonymizes `granted_by_user_id`
  to `deleted-user` on recipients' rows.
- `credit_debit_progress`: per user, UTC month, and debit meter, the billable
  units above the include already debited or forgiven, so hourly debits stay
  idempotent. All three credit tables are durable forever until account
  deletion/export.
- `feature_flag_exposure_rollups`: local-dev/test flag exposure rollups keep 90
  days by `day` key, matching Analytics Engine retention for the production
  `FLAG_EXPOSURES` exposure stream; the admin metric readout window is the
  current month.
- `platform_feedback`: open and triaged rows remain until review changes them to
  resolved or dismissed, or the submitter deletes their account. Resolved and
  dismissed rows keep 365 days after `updated_at`; submitter deletion removes
  any remaining rows.
- `audit_events`: global hashed auth/security audit events live only in the
  dedicated `AUDIT_DB` database. All persisted writes, admin reads, insights,
  and auth-denial alerts use that binding; the hourly retention lane prunes rows
  after 180 days. Audit events are not user-owned and remain independent of
  account deletion/export.
- `stripe_webhook_events`: platform Stripe webhook idempotency rows keep 30 days
  by `processed_at`. They are not user-owned and remain independent of account
  deletion/export.
- `agent_package_conversation_uses`: per-user package conversation-use rows keep
  180 days by `last_used_at` (`agentPackagePopularityMaxAgeDays`). The prune
  orders by the existing `(user_id, last_used_at)` time index via `last_used_at`
  then `rowid`.
- Unverified person accounts: password signups that stay unverified
  (`users.email_verified_at` is null) for seven days and have no
  `oauth_connections` row are deleted by the hourly `unverified_account_purge`
  lane. Each run selects a bounded batch of never-attempted rows first, then
  oldest `created_at`, skipping rows whose `deleting_at` is inside a retry
  backoff. Before deletion it claims the row atomically (restamping
  `deleting_at` only while eligibility still holds). Once claimed, verify-email
  and social-login reclaim refuse the fenced account. A claim-created fence is
  released only on pre-cleanup failures; a partial-cleanup failure leaves the
  fence for retry. Outcomes are recorded best-effort: a purge writes an
  `unverified_account_purged` audit row and a failed deletion writes an
  `unverified_account_purge_failed` audit row (reason
  `<ErrorClassName>: <first inventory/cleanup warning or message>`, email
  addresses redacted, at most 200 characters) plus a Sentry event when Sentry is
  configured. Either sink being unavailable is logged and skipped rather than
  failing the batch, so the durable record can have gaps when `AUDIT_DB` is
  down; the on-demand capability below is the authoritative read. The admin-only
  `adminUnverifiedAccountPurgeRun` capability runs one bounded pass on demand
  (or previews the claim page with `dryRun`) and returns per-account outcomes
  keyed by stable user id. Social-login accounts are verified at creation and
  are not in this set.

The squashed baseline defines the global time-column indexes these prunes order
by (`created_at` / `day` / `month` / `started_at` across users); per-user
composite indexes cannot serve those ordered scans.

Documented exemptions: `jobs` are package-owned and stay until package sync,
package deletion, or account deletion, and `mcp_memories` is exempt because
memories are durable user-curated content removed by explicit user action or
account deletion rather than by time-based retention.
