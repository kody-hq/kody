# Account storage lifecycle

[Data storage overview](./index.md)

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
times (see [`entitlements.md`](../entitlements.md#account-deletion-refunds)).
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
  `UserMeter`, `StripePlanRefresh`, `Mailbox`, and `FileStore` are purged
  through account-deletion RPCs after their identifiers are collected (`RunLog`,
  `UserMeter`, `StripePlanRefresh`, `Mailbox`, `RepoSessionIndex`, and
  `FileStore` are one object per user and need no D1 id scan). Account deletion
  first captures the authoritative USER raw-MIME and attachment references
  through `Mailbox.listBlobReferences`, deletes those owner-safe R2 keys plus
  defensive owner-prefix sweeps, and only then calls `Mailbox.purge()`. The
  purge clears DO SQLite only (see
  [Mailbox](services.md#durable-objects-mailbox)). `MCP` objects remain SDK
  session-keyed, while `mcp_agent_sessions` indexes each Durable Object id by
  authenticated stable user id so account deletion can purge stored props,
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
  `Mailbox.purge()` never deletes R2 objects. File revision and collaboration
  checkpoint bytes in `FILE_BLOBS` are inventoried by `FileStore.inventory`
  (`collectAccountR2Inventory`) when `FILE_STORE` is bound. Account deletion
  does not delete those keys from the inventory list: `FileStore.purge`
  prefix-deletes `files:v1/{ownerId}/` then clears the catalog. RepoSession
  workspace spill in `REPO_SESSION_BLOBS` is ephemeral scratch keyed by Durable
  Object id (`repo-session:{durableObjectId}/`). Account deletion enumerates
  session ids and each `purgeSession` prefix-purges that object's keys after
  `deleteAll`.
- **KV:** published bundle artifact keys, source/manifest snapshot keys,
  community listing snapshots, package-skills index keys, package codemod revert
  keys, and MCP OAuth refresh-family snapshot/replay keys
  (`derived-cache:v1:mcp-oauth-refresh-{family,replay}:{userId}:`) in
  `BUNDLE_ARTIFACTS_KV` are deleted before D1 projection rows are removed. OAuth
  token/grant KV is owned by the OAuth provider and is handled through provider
  grant revocation rather than app-level key scans.
- **Cloudflare Artifacts:** source repos referenced by `entity_sources` and the
  per-user `RepoSessionIndex` catalog are deleted through the REST client in
  `packages/worker/src/repo/artifacts.ts`.

## Organizations a deleted person leaves behind

`deleteUserAccount` deletes the person's `org_memberships` rows and anonymizes
`orgs.created_by_user_id`. It does not delete any `orgs` row. A caller that
hard-deletes a person must settle that person's organizations itself, with the
rules `softDeleteUserAccount` (`packages/worker/src/orgs/soft-delete.ts`)
applies to self-serve deletion:

| The person is                                             | What happens                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| the only member of a team org                             | the org is soft-deleted, then hard-purged, packages included       |
| the only Owner of a team org that still has other members | nothing is deleted; the deletion is refused or skipped and audited |
| a member of a team org that has another Owner             | only the membership is removed                                     |

Paths that hard-delete a live person (no restore window) call
`hardDeleteLivePersonWithOrgs` in `packages/worker/src/orgs/hard-purge.ts`
instead of `deleteUserAccount`. It applies the table above, deletes the person,
then deletes the personal org row. Today those paths are the unverified-account
purge, the guest purge, and guest claim into an existing account. A fenced retry
goes through `finishLegacyUserDeletion`, which applies the same table. Admin
hard-delete and the soft-delete purge lane settle team orgs in
`softDeleteUserAccount` first and pass `purgeSoftDeleted`.

A refused deletion throws `UserDeleteBlockedSoleOwnerError` before anything
changes and is audited with reason `sole_owner_with_other_members`
(`unverified_account_purge_skipped`, `guest_account_purge_skipped`,
`guest_account_claim_blocked`). The person stays until another Owner is promoted
or the other members are removed.

`deleteUserAccount` also fails closed: without `purgeSoftDeleted` it throws
`PersonHardDeleteWouldOrphanTeamOrgError` when the person is still the only
member of a live team org. A new deletion path that skips the helper cannot
leave a live team org with no members.

The admin-only `adminMemberlessTeamOrgsCleanup` capability finds organizations
that earlier deletions left live with no live members. `dryRun` defaults to
`true` and lists ids, slugs, and package counts. With `dryRun: false` it
soft-deletes and hard-purges each listed organization. It matches organizations
that are not a person's personal org and have a creator, so it also lists
personal org rows left behind after their person was hard-deleted. Nothing runs
it automatically.

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
`published_bundle_artifacts`). The
[`hardPurgeOrg` guard](../../../../packages/worker/src/orgs/hard-purge.ts)
defers a soft-deleted person's personal org to the person purge. The person
purge runs account deletion first (reading the Stripe customer from the personal
org row, canceling subscriptions, and deleting the customer), then deletes the
personal org graph; the
[scheduled purge billing test](../../../../packages/worker/src/orgs/hard-purge.node.test.ts)
covers this ordering. Production sets `SOFT_DELETE_PURGE_ENABLED` to `true`, so
the hourly purge lane hard-deletes soft-deleted rows past the 30-day restore
window. Preview and test keep it `false`, where the lane only lists those
candidates. Legacy account deletions (`deleting_at` set, `deleted_at` null) are
finished by the same lane regardless of that flag; see
[authentication](../authentication.md). Fleet scans (published-commit ref repair
and package codemods) skip packages whose owner is mid-deletion or deleted
(`account/owner-deletion-state.ts`). Out-of-band surfaces (Durable Objects, KV
schemes, R2, Vectorize, Artifacts) are declared in `user-owned-surfaces.ts` and
consumed by both deletion and export. Growth-table retention dispositions are
linked in `account-retention-dispositions.ts`.
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
token hashes. Guest claim lookup hashes and sealed claim codes are covered by
that rule, but `guest_accounts` is not an export target, so the manifest does
not list them. The manifest lists redacted columns only for exported tables so a
partial or intentionally redacted export is not mistaken for a complete secret
backup.

The browser route `GET /account/export.json` downloads a bounded metadata
manifest for the signed-in user and identifies the MCP capabilities required for
a complete export. It deliberately does not inline D1 rows, Durable Object
state, or R2 bytes. The MCP capability domain `account` provides the complete,
migration-safe chunked interface:

- `accountExportManifest` returns the manifest, counts, warnings, and chunking
  instructions. Every manifest section carries a `discovery` object with the
  exact `accountExportSection` arguments that read it: `d1.<table>` keys map to
  `section: "d1_table"` plus `table`, `storage_runners` maps to
  `durable_object_summaries` with `kind: "storage_runner"`, and every other key
  (for example `artifact_repos`, `kv_keys`, `oauth_grants`) is its own section.
  Wrong arguments (a section name passed as a D1 table, a missing `table`,
  `storage_id`, or `kind`, an unknown storage id, a malformed cursor) are caller
  errors whose message names the call to make instead.
- `accountExportSection` pages through one section at a time. D1 rows are read
  with `section: "d1_table"` and a table name. Durable storage buckets are read
  with `section: "storage_runner"` and a `storage_id`, using the same
  StorageRunner `exportStorage({ pageSize, startAfter })` RPC as the dedicated
  storage export capability. User meter counters use `section: "user_meter"` and
  the `UserMeter.exportCounters` RPC (daily counters plus authoritative
  `storageBytesState`, sanitized `deletionState`, and
  `inboundConnectionLastUsed` on the first page only when present). Mailbox
  metadata uses `section: "mailbox"` and the `Mailbox.exportMailbox` RPC. R2 raw
  MIME, attachment, avatar, icon, and file-revision objects use
  `section: "r2_object"`; each response contains at most one chunk of up to 256
  KiB of raw object bytes, returned as base64 `contentBase64`, and an opaque
  cursor. Email, avatar, and icon requests use bounded `LIMIT 1` ownership
  queries rather than reconstructing inventory; file revisions page from
  `FileStore.inventory`. Continuation cursors bind the source row, object key,
  size, and ETag; ownership/key mutations and object overwrites are reported
  instead of mixing generations. Missing objects are represented explicitly. R2
  cursor version 1 is unsupported by the current Mailbox-authoritative traversal
  because translation could duplicate bytes; callers must restart the
  `r2_object` section without `startAfter`. File metadata is not in `r2_object`.
  Page `section: "file_store"` for file records, collaboration state, and
  public-link state from `FileStore.exportMetadata`. File bytes stay in
  `r2_object`; that reader resolves each file object through `fileObjectReader`
  (`FILE_BLOBS` or a configured external R2/S3 provider).

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
  [Run records](../run-records.md).
- `UserMeter` exports daily entitlement counter rows through the `user_meter`
  section (`exportCounters` RPC; keyset pagination by UTC `day` and `resource`).
  The same RPC returns authoritative `storageBytesState`, sanitized
  `deletionState`, and `inboundConnectionLastUsed` on the first page only
  (`startAfter` absent; `null` on later pages). Section totals count each state
  inventory once when present. The storage-byte counter lives only in UserMeter.
  Retention is self-enforced inside the DO (fourteen UTC days of counter and
  inbound-delivery-claim rows); storage-byte state is not time-pruned. See
  [Entitlements](../entitlements.md#usermeter).
- `Mailbox` is the sole authoritative USER email graph export. It exports
  threads, messages, attachments, and delivery events through the account-export
  `mailbox` section (`exportMailbox` RPC; keyset pagination with prefixed
  cursors); manifest counts use `countMailbox`. No shared USER D1 graph exists,
  so the D1 export contains no duplicate email metadata. USER R2 export
  enumerates raw MIME and attachment keys with `Mailbox.listBlobReferences`.
  Internal `email_message_retention_retries` rows defer failed R2 deletion
  attempts without blocking other expired messages; they are likewise excluded
  from export/counts and removed with message or mailbox purge. See
  [Mailbox](services.md#durable-objects-mailbox).
- `FileStore` exports org-file catalog rows, revision manifests, collaboration
  state, and public-link state through the account-export `file_store` section
  (`exportMetadata` RPC). File bytes are not in that section; they page through
  `r2_object` as above. See
  [R2](services.md#r2-community_assets-email_blobs-file_blobs-repo_session_blobs).
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
