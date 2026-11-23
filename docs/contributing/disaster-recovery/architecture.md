# Disaster recovery architecture

What the backup covers, how each store is captured and sealed, and what restore
rebuilds or accepts as lost. Start at the
[disaster recovery index](../disaster-recovery.md).

## Objectives

| Scope                 | RPO | Notes                                                                                                                                                                                                                                                                                  |
| --------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All canonical stores  | 24h | APP_DB, JOBS_DB, per-user Mailbox graphs, StorageRunner dumps, `EMAIL_BLOBS` / `COMMUNITY_ASSETS` blobs, published package source snapshots. `REPO_SESSION_BLOBS` is ephemeral session scratch and `OPERATOR_BACKUPS` holds operator rollback snapshots; neither is a canonical store. |
| APP_DB (`kody`)       | 24h | Paced D1 lane (nightly sealed base plus deltas); hourly paced freshness; deep checksum via the isolated paced restore drill.                                                                                                                                                           |
| JOBS_DB (`kody-jobs`) | 24h | Paced D1 lane for scheduled-job definitions (`jobs`); hourly paced freshness; isolated paced restore drill. Job definitions do not live in APP_DB.                                                                                                                                     |
| Selected RunLog state | 24h | Never-pruned job observability, package-run success counters, and activation milestones; run history and correctness ledgers remain excluded                                                                                                                                           |

RTO is whatever the operator can achieve with the UI restore workflow after a
successful sealed-day drill. There is no provider-level cross-store atomic
snapshot.

Retention (UTC):

- `daily/` — ~35 days (immutable lock + lifecycle)
- `weekly/` — ~400 days (Sunday UTC D1 exports under `weekly/d1/...`)
- `blobs/sha256/` — long-retention content-addressed store shared across days
- Failed or incomplete sets never replace a sealed day

## Architecture

Two cooperating writers share one locked bucket in the independently
administered **DR (“KCD”) Cloudflare account**:

```text
Production worker (source account)          Backup control plane (DR account)
───────────────────────────────             ────────────────────────────────
Nightly */5 ticks 00:30–06:10 UTC           Hourly :45: seal complete days
  prefer oldest stranded day (≤14 days),     from sealed paced D1 nights +
  else stage today: Mailbox / RunLog /        staging summaries
  StorageRunner / R2 / artifacts        →
  into staging/{day}/...
Daytime */5 ticks: staging catch-up         Admin UI: drill / production restore
  resume oldest stranded day (≤14 days)     Agent seal API: `/__maintenance/dr-seal`
06:15 UTC: staging watchdog → Sentry
Same nightly window: paced D1 walk          Isolated paced restore drill and
  APP_DB + AUDIT_DB + JOBS_DB → d1-paced/…   graduated restore read d1-paced/…
Hourly :45 / Sunday 07:00: paced freshness  GET /__maintenance/dr-paced-status
  and weekly paced restore drill → Sentry
```

### What intentionally lives on the DR (KCD) account

The DR (“KCD”) Cloudflare account (`a41d50ecaf0ae0f86dd1824ef6729cb2`) is the
old pre-migration production account, kept as the independently administered DR
destination. Production runs on the Kody account
(`a99ee2e72728dd52902ef288b7b1447d`). Future account cleanups must not delete
the kody-named resources below — they are intentional cross-account leftovers.

**DR / backup stack (this runbook):**

- Worker `kody-production-d1-backups` (hourly seal cron)
- Workflows `kody-production-dr-restore`, `kody-production-paced-restore-drill`,
  and `kody-production-seal-day`
- Locked R2 bucket `kody-production-backups`
- Custom domain `kody-dr.kentcdodds.com`

**Personal journaling package data** (not platform infrastructure; reached via
API tokens from Kent's personal Kody packages, not Worker bindings):

- D1 `kody-journals`
- Vectorize index `kody-journals`
- R2 buckets `kody-journals` and `kody-journals-backup`

**AI Gateway `kody`** — still used by personal package jobs against that
account's Workers AI. The platform's own `AI_GATEWAY_ID` routes through the
same-named gateway on the production (Kody) account via the Workers AI binding,
which is account-scoped; the two gateways are independent.

### Bucket layout

Contract: `packages/shared/src/backup-staging.ts`.

| Prefix                                      | Mutability       | Contents                                                                                                  |
| ------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `daily/d1/...`, `weekly/d1/...`             | Immutable        | REST-era D1 SQL + manifests from the removed export; not restorable, expire under lifecycle               |
| `staging/{day}/d1-paced/{databaseName}/...` | Mutable          | Paced D1 night walk (progress, table TSV, parts, night manifest)                                          |
| `daily/d1-paced/{databaseId}/{day}/...`     | Immutable        | Sealed weekday paced nights                                                                               |
| `weekly/d1-paced/{databaseId}/{day}/...`    | Immutable        | Sealed Sunday UTC paced full bases                                                                        |
| `staging/{day}/...`                         | Mutable          | Production exporter cursor progress, chunked phase output, indexes, NDJSON dumps, `exporter/summary.json` |
| `daily/full/{day}/...`                      | Immutable        | Sealed copy of staged indexes/dumps + Ed25519 full-backup manifest                                        |
| `blobs/sha256/{hash}`                       | Immutable        | Deduplicated email MIME, community assets, published source snapshots                                     |
| `escrow/`                                   | Operator-managed | Sealed `SECRET_STORE_KEY` blob (`escrow/secret-store-key.v1.json`)                                        |

### Capture lanes

1. **D1 (REST export, removed)** — Until #4306 the control plane exported APP_DB
   and JOBS_DB nightly through the Cloudflare D1 export API into
   `<tier>/d1/<database-uuid>/<day>/` with signed schema-v2 manifests. That
   export lane, its cron, Workflow, freshness check, and `restExport` flag are
   gone; the paced walk below is the only D1 backup. The read-only REST restore
   reader was removed on 2026-11-22, so schema-v3 paced days are the only
   restorable format: restore rejects a schema-v1/v2 full manifest with
   `restore-rest-era-day`, naming the day. The REST objects already written are
   not converted, modified, or manually deleted; they expire under R2 lifecycle
   (`daily/` about 35 days, so the last REST-era daily full manifest,
   2026-11-16, ages out in late December 2026; `weekly/d1/` about 400 days, with
   no weekly full manifest to restore them through). `SOURCE_DATABASES`
   (`{ id, name }` entries) lists the D1 databases graduated restore may target;
   `SOURCE_DATABASE_ID` / `SOURCE_DATABASE_NAME` remain the primary APP_DB
   identity. Gates: `ENABLE_PRODUCTION_D1_BACKUPS` and
   `BACKUP_BENCHMARK_APPROVED` must both be exactly `"true"` for the seal cron
   to run. The production `kody-jobs` UUID is resolved by name in
   `tools/ci/jobs-worker-resources.ts` (`jobs_d1_database_id`). **D1 paced walk
   (production worker)** — When `DR_D1_PACED_BACKUP_ENABLED` is `"true"` and the
   same DR S3 credentials are set, the production worker walks APP_DB, AUDIT_DB,
   and JOBS_DB page-by-page (`packages/worker/src/dr/d1-paced-backup.ts`) in the
   same nightly window as non-D1 staging. Staging lives under
   `staging/{day}/d1-paced/{databaseName}/`. Completed nights seal to
   `daily/d1-paced/{databaseId}/{day}/` (weekdays) or
   `weekly/d1-paced/{databaseId}/{day}/` (Sunday UTC full bases). Tick writers
   flush TSV parts at 4 MiB on page boundaries. Each table walk stops after 32
   MiB emitted so the next tick can resume; see
   [`d1-paced-backup.ts`](../../../packages/worker/src/dr/d1-paced-backup.ts).
   Ticks run on a 45s budget. Full-base nights (every Sunday UTC night, plus
   nights with a force-full-base request) run 180s ticks that stop after 128
   MiB: a full base is about 1.5x a delta night's work, and on 2026-11-22 it
   needed about 72 tick-minutes while 45s ticks fit about 62 before the 07:00 DR
   health check, so AUDIT_DB sealed at 07:41. Seal also stops between parts of a
   parted table when the budget runs out and resumes on the next tick without
   recopying sealed parts, so one large table never needs a tick longer than the
   budget. A delta tick that stops mid-table records the previous-night index
   part its merge-join reached (`prevIndexPart` in `progress.json`), and the
   next tick reopens the previous index at that part, so a resume costs one
   index part instead of the whole previous index. Only one paced backup tick
   runs at a time: a tick claims the `dr_d1_paced_backup` row in
   `scheduled_lane_leases` (2 minutes), a tick that finds the lane held skips
   with `reason: "lease-held"`, and a tick that outlived its lease re-checks
   (and extends) it before every bucket write and stops with
   `D1PacedBackupLeaseLostError` instead of writing. Seal refuses a table whose
   index is not strictly increasing by rowid (`PacedD1IndexOrderError`, raised
   before any sealed object for that table is written), so the night stays
   unsealed and the lane fails in Sentry on every tick until the staging table
   is rebuilt. The weekly Sunday drill (07:00–08:59 UTC) verifies each table's
   tip checksum from the sealed chain, streaming one part body at a time and
   keeping only the rowids touched by deltas since the last `full` base. It is
   resumable: each tick holds a D1 lease, drills the next unfinished source for
   up to 4 minutes, and checkpoints every table in APP_DB
   (`dr_paced_restore_drill_runs` / `dr_paced_restore_drill_sources`). A tick
   that dies mid-table (OOM, CPU, wall) leaves an active marker; the next tick
   reports it and retries, and a second death fails that table. Ticks from 08:50
   fail unfinished sources (`deadline-exceeded`). Drill failures get their own
   Sentry fingerprint `dr-d1-paced-restore-drill / <kind> / <source>` (kind
   `oom`, `timeout`, `interrupted`, `deadline`, `mismatch`, `error`) at level
   `fatal` with `dr.drill.source` / `dr.drill.phase` tags, so a platform reset
   never folds into a generic (possibly ignored) OOM issue; the jobs worker asks
   `JobsHost.readD1PacedRestoreDrillCheckpoint` for the source and phase when
   the RPC itself dies. Graduated production restore and the isolated paced
   drill replay the same sealed paced chains for schema-v3 days. The
   [paced status endpoint](../../../packages/worker/src/dr/d1-paced-status.ts)
   reports backup freshness and the latest restore drill. `DR_D1_PACED_SOURCES`
   commits APP_DB + AUDIT_DB + JOBS_DB (deploy still expands live D1 UUIDs from
   resource bindings).
2. **Other canonical stores (production worker)** — When
   `DR_EXPORT_ENABLED=true` and DR S3 credentials are set, nightly ticks
   (`packages/worker/src/dr/exporter.ts`) stage:
   - **Mailbox** — owner inventory from D1 `users.stable_user_id`, with one
     keyset-paged `Mailbox.exportMailbox` NDJSON dump per owner and a
     checksummed mailbox index. Mailbox is the sole authority for USER email
     threads, messages, attachments, and delivery-event metadata; raw MIME and
     external attachment bytes remain in `EMAIL_BLOBS` and are captured by the
     R2 lane.
   - **Selected RunLog state** — the same owner inventory, with `exportRuns`
     started at its `job-run-observability:` cursor so only the never-pruned
     `job_run_observability`, `package_run_successes`, and
     `activation_milestones` tables are staged. Retained run/log history,
     invocation-ledger rows, and workflow projections are deliberately skipped.
   - **StorageRunner** — platform-wide inventory from D1, NDJSON dump per
     storage identity via `exportStorage`
   - **R2** — `EMAIL_BLOBS` and `COMMUNITY_ASSETS` listed and copied into
     `blobs/sha256/{hash}` with per-bucket NDJSON indexes (objects above 25 MiB
     are skipped with a warning in the staging summary). A `StorageRunner` dump
     larger than the 16 MiB buffer is written as consecutive parts under
     `storage-parts/{id}/{sha256}.ndjson` (content-addressed, so a retried part
     never adopts different bytes), each a `storage-index.json` entry with its
     `part`, and restore imports them in order into one replace. Until
     2026-11-18 such a dump was skipped with a `storage dump too large` warning
     and was not backed up. An object whose key, size, ETag, and uploaded
     timestamp match the latest retained sealed-day index reuses that index
     entry and content-addressed blob without downloading or hashing the source
     object. Missing, malformed, or checksum-mismatched sealed indexes fall back
     to the full download and hash path.
   - **Published artifacts** — `BUNDLE_ARTIFACTS_KV` published source snapshots
     for rows in `entity_sources` with a `published_commit`. Snapshots are
     settled 8 at a time: each is hashed as a stream and its
     `blobs/sha256/{hash}` key is checked, so a snapshot whose blob is already
     stored is never buffered. Only a new snapshot is read into memory, one at a
     time. Progress is persisted once per wave. Unchanged R2 objects check their
     blob keys in the same waves of 8.
   - **Stranded-day drain** — a night with more staging work than the
     00:30–06:10 window can hold ends with `exporter/progress.json` but no
     `exporter/summary.json` (a _stranded day_; first hit live on 2026-08-07).
     Every worker cron tick (nightly window and daytime catch-up) scans today
     plus the previous 14 days for progress-without-summary and resumes the
     oldest stranded day under the normal ~45 s budget and progress lease until
     its summary is written; when none are stranded, nightly ticks stage today.
     When nightly defers today for an older stranded day, it create-only seeds
     today's `exporter/progress.json` if neither progress nor summary exists so
     catch-up can resume tonight after backlog drains. Catch-up is disabled
     during the nightly window so the two lanes do not double-run the same tick.
     The 14-day lookback stays above both the 2026-09 failure (eleven days aged
     out under a 2-day window) and the 2026-10 pace (~28h wall clock per staged
     day at ~700 Mailbox owners). Mailbox and RunLog fetch 8 owners per wave
     inside the 45s tick, which should finish a day well inside 24h; the wide
     lookback is what keeps a regression from aging a day out mid-phase.
     Catch-up is resume-only: a day that never staged progress is not started
     fresh (its dumps would contain current data, not that day's). Data staged
     during catch-up is read at resume time; a slightly newer dump is preferred
     over an unsealable day.
   - **Resumable phase state** — `exporter/progress.json` contains phase
     cursors, counters, bounded index-entry tails, and conditional-write
     revision data. Mailbox, selected RunLog, and StorageRunner dump pages plus
     all phase index entries are written under `exporter/chunks/` as bounded
     NDJSON objects. Finalization reads those chunks and emits the stable
     mailbox, RunLog, storage, R2, and artifact index contracts referenced by
     `exporter/summary.json`. Chunk objects are content-addressed linked lists
     whose head keys and counts live in progress. Stale writers can therefore
     leave only unreferenced chunks; they cannot overwrite chunks selected by a
     newer lease. Progress updates retain `If-Match` ownership semantics.
     Canonical per-day dumps, indexes, and the completion summary are
     create-only; a resumed writer adopts an already completed object instead of
     replacing it. A per-owner Mailbox or RunLog dump larger than the 16 MiB
     buffer is split the same way, into `mailbox-parts/{owner}/{sha256}.ndjson`
     or `run-log-parts/{owner}/{sha256}.ndjson` entries that carry `part` in the
     owner index. See
     [Mailbox re-import](./restore.md#automated-mailbox-re-import) for how
     recovery reads split dumps.
3. **Seal** — Control plane verifies staged checksums against
   `staging/{day}/exporter/summary.json`, requires the sealed paced D1 night for
   every `D1_PACED_SOURCES` entry (APP_DB, AUDIT_DB, JOBS_DB) when sealing a new
   day, copies staged files under `daily/full/{day}/...`, and signs a
   full-backup manifest (`packages/shared/src/backup-full-manifest.ts`).
   Schema-v3 seals list each paced night (key and SHA-256) under `d1Paced`, the
   D1 source of truth. A missing or unparseable paced night returns
   `paced-d1-seal-missing` or `paced-d1-seal-corrupt` with the source name. New
   seals carry no REST D1 fields (`d1ManifestKey`, `d1ManifestSha256`,
   `d1Sources`); some schema-v3 manifests sealed while the REST export lane
   existed still carry them as signed, never-read evidence. Graduated production
   restore of a schema-v3 day replays each sealed paced chain into its source
   database, one workflow step per unit, then re-hashes every restored row and
   fails with `restore-paced-verify-mismatch` when a count or checksum differs
   from the sealed tip manifest. A paced source without a sealed manifest is
   refused before the safety export (`restore-paced-seal-missing`). REST
   evidence on a v3 day is never imported. Schema-v1 and schema-v2 days are
   refused before any production call (`restore-rest-era-day`). Already-sealed
   days short-circuit before source checks. The hourly `:45` cron attempts to
   seal the last sixteen complete days synchronously. The UI seal action
   enqueues workflow `kody-production-seal-day` for that day and returns
   immediately.

### Restore-safe row sizes

D1's import path rejects individual SQL statements above its ~100 KB
statement-length limit (`statement too long: SQLITE_TOOBIG`), and D1 exports
write one INSERT per row — so a single oversized row makes the whole D1 backup
un-importable. This is not hypothetical: drills of the 2026-07-26 production
export failed on oversized `package_invocations.response_json` rows until the
rows were bounded.

- Write paths bound large text columns via
  `packages/shared/src/backup-restore-safety.ts` (64 KiB per column):
  package-invocation replay caches are dropped when oversized, and stored email
  bodies are truncated (raw MIME in R2 stays canonical). Large payloads belong
  in durable storage.

### Derived and accepted-loss stores

Restore rebuilds the derived stores below; do not treat them as recovery media:

- Vectorize (`CAPABILITY_VECTOR_INDEX`) — reindex with
  `POST /__maintenance/reindex-capabilities` `{ "force": true }` (omit `phases`
  so every kind rebuilds; follow `cursor` until `complete`). D1 restore includes
  `vector_embed_fingerprints`; without `force`, matching hashes skip Vectorize
  upserts.
- OAuth KV / browser sessions / provider tokens — users reconnect
- Queues, Workflow instances, Durable Object alarms — recreate from config + D1
  (`JobManager` alarms rebuild from restored `JOBS_DB`)
- Derived community icons and ordinary KV caches
- **UserMeter** — daily entitlement counters self-prune and can be
  re-established by traffic; authoritative storage-byte state is corrected by
  the revision-guarded physical-storage reconciliation lane. Losing UserMeter
  state can temporarily undercount usage, but it does not lose stored user
  content; this is accepted rather than adding a nightly UserMeter dump lane.
- **RunLog run history** — per-user runs and console lines have ~30-day
  self-enforced retention and remain accepted observability loss. Account
  export/deletion still cover them for user-facing portability and purge.
  Nightly DR starts `exportRuns` at `job-run-observability:` and therefore
  captures only job observability, package-run success counters, and activation
  milestones.

  **Known risk — keyed invocation idempotency ledger:** the same `RunLog` DO
  also holds the keyed package-invocation idempotency ledger (claims + 90-day
  terminal replay responses). There is no D1 `package_invocations` table; the DO
  is the only store. Losing the DO therefore loses idempotency/replay state, not
  just observability: webhook providers and other keyed callers that retry
  deliveries would **re-execute** invocations whose keys were already terminal,
  and in-flight replays would return fresh executions instead of stored
  responses. This is accepted with eyes open: lost rows are gone — later traffic
  re-establishes claims only for keys used after the loss, it does not restore
  protection for keys used before it. The blast radius is duplicate side effects
  (a loss of correctness state) bounded by the 90-day retention window; no
  stored user content is lost. The DO ledger is not part of DR media, and D1
  backups do not carry any invocation ledger.

- **RunLog workflow projections** — correctness projections are also before the
  selective export cursor and remain excluded. Incident handling must treat
  in-flight workflow state as lost and restart or reconcile affected workflows.
- **`AUDIT_DB`** — the separate D1 database containing hashed security audit
  events with 180-day retention is included in the paced D1 walk
  (`DR_D1_PACED_SOURCES`) and restored from it by graduated production restore
  on schema-v3 days. Paced sealed nights are the backup lane for this evidence.
  Scheduled job definitions live in `JOBS_DB` (`kody-jobs`) and are part of the
  paced D1 walk; APP_DB does not store them.

### Honest gaps

- **Artifacts Git history** is not mirrored. Only published source snapshots in
  `BUNDLE_ARTIFACTS_KV` are staged. Full repo history is not restorable from
  backup media.
- **Unpublished / in-progress repo-session work** is not exported.
- **Mailbox restore is a separate post-D1 step.** Staging and sealing protect
  the authoritative graph and verify every owner dump against the mailbox index.
  Graduated D1/StorageRunner/R2/artifact restore does not import Mailbox rows;
  with ingress disabled, run
  [Automated Mailbox re-import](./restore.md#automated-mailbox-re-import) (or
  the [manual fallback](./restore.md#manual-mailbox-re-import-fallback)) and
  require `"done": true` plus `"verified": true` before re-enabling ingress.
- **StorageRunner restore is replace-per-bucket** (`importStorage` mode
  `replace`): each inventoried storage id is cleared and rewritten from the
  sealed dump. Storage ids absent from the inventory are not deleted by restore.
- R2 restore puts sealed objects back by key; it does not sweep orphans that
  appeared after the sealed day.
- **StorageRunner inventory** unions authoritative sources: `jobs` storage ids
  from the jobs worker (`JOBS_DB` via the `JOBS` / `JobsStore` path), plus
  `APP_DB` `user_storage_buckets` (including ad-hoc / execute buckets). Buckets
  known only inside a user's `RunLog` (and never registered in
  `user_storage_buckets` or an entity table) remain outside DR inventory by
  design; the selective RunLog lane does not export run-associated storage ids.

## Explicit exclusions

- Continuous replication, zero RPO, or cross-store atomic snapshots
- Live proof of deployment/locks/escrow merely because code exists
- D1 availability during export; non-destructive Time Travel clone
- D1 `file_size` ≥ 4.5 GB or any export/restore object ≥ 5 GiB (rejected)
- Multipart D1 capture / statement-safe split restore
- Full Artifacts Git history or unpublished repo-session work
- Backup of Vectorize, OAuth KV, queues, Workflow runtime, Durable Object alarms
  (JobManager rebuilds alarms from restored `JOBS_DB`; other DOs follow their
  own restore or accepted-loss paths)
- Backup of `RunLog` run records and logs (observability; ~30 day DO
  self-retention), invocation idempotency ledger, and workflow projections;
  never-pruned job observability and activation state are backed up
- Backup of UserMeter (reconciliation/restart is the accepted recovery path)
- Restore of REST-era (schema v1/v2) days; the reader was removed on 2026-11-22
- Plaintext `SECRET_STORE_KEY` or other credentials inside backup media

## Provider references

- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 export REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
