# Production D1 backup control plane

This package is a dedicated scheduled Worker and Workflow. It is intentionally
separate from application cron and does not use `DynamicCallableWorkflow`.

## Retention prefixes

The schedule and key policy use UTC exclusively:

- Sunday UTC backups use `weekly/d1/<database-uuid>/<yyyy-mm-dd>/...` and the
  manifest retention tier `weekly`.
- All other UTC weekdays use `daily/d1/<database-uuid>/<yyyy-mm-dd>/...` and
  retention tier `daily`.

Each export object is immutable and bookmark-derived:
`<tier>/d1/<database-uuid>/<yyyy-mm-dd>/backup-<encoded-bookmark>.sql`. The day
has one canonical immutable `manifest.json` per database, which records that
source's id, name, SQL key, byte count, and sha256. If a process crashes after
writing SQL but before its manifest, a later Workflow-step retry reuses the
cached export bookmark and therefore inspects the same object before
constructing the absent canonical manifest. The original one-hour signed URL
returned by the durable export step is never used for transfer. On every
execution of the retryable upload callback, the runtime polls D1 with the cached
bookmark and requires a complete response for that same bookmark, obtaining a
fresh signed URL. If that poll result has expired, the callback fails with
`export-result-expired` (non-retryable) instead of starting a second export, so
one upload step never blocks the source database twice; the instance retry
starts a single new export. The upload stream-verifies exact byte count and
SHA-256 against R2 while writing. Finalization deliberately does **not** poll D1
again: expired poll results can only be refreshed by starting a new export of a
_newer_ database state, whose bytes legitimately differ from the stored object
whenever production wrote anything in between (this exact mismatch made roughly
every other nightly backup fail terminally with
`existing-object-source-mismatch` before 2026-07-27). Instead, finalization
re-reads the stored object and requires its size, R2 ETag, and full SHA-256 to
match the durable upload-step result (`stored-object-mismatch` /
`stored-object-missing` fail closed), then signs and writes the manifest in the
same Workflow step. An existing manifest must match that object exactly.

While streaming the upload, the runtime also measures SQL statement lengths
(quote-aware semicolon splitting). D1's import path rejects statements above its
~100 KB statement limit with `statement too long: SQLITE_TOOBIG`, so an
oversized statement means the object is not restorable through the D1 import
API. The measurements are persisted as `<objectKey>.stats.json` next to the SQL
object before manifest finalization and logged as `backup-sql-stats`. An
oversized count above zero additionally logs `backup-unrestorable-statements`,
fails the Workflow retryably, and leaves the day without a canonical manifest.
The hourly catch-up window can then re-export the same day after the offending
write path or row is bounded.

Sealing, freshness, restore drills, production restore, and the dashboard all
read the SQL object's stats sibling. Oversized statements prevent sealing and
import, freshness emits `freshness-unrestorable`, and the dashboard marks the
day's D1 media as not restorable. Missing stats are tolerated with a structured
legacy warning only for retained objects before 2026-07-28; newer objects fail
closed.

Every canonical manifest uses schema v2 and is an Ed25519-signed envelope. Its
signature covers deterministic canonical JSON for the SQL key, bytes, SHA-256,
R2 ETag, source account/name and D1 UUID/name, bookmark and export timestamps,
build commit, retention tier, trusted restore-baseline id/digest, algorithm, and
key id. Exact envelope bytes are written only after signed-source comparison and
signing succeed. Signing failure may leave SQL for safe retry, but no manifest.

Configure the production R2 bucket lifecycle by these immutable prefixes:

- `daily/`: expire after approximately 35 days.
- `weekly/`: expire after approximately 400 days.

R2 lifecycle rules are bucket configuration and are deliberately not encoded as
application deletion logic. Before deployment, replace every placeholder in
`wrangler.jsonc`, create those lifecycle rules, provide the API token as a
secret, and set both enable variables to exactly `true` only after the export
benchmark is approved.

Workflow instance retention is omitted intentionally so Cloudflare applies the
maximum available to the account (currently up to 30 days on paid plans and
three days on free plans). This is separate from R2 backup retention.

## Source size ceiling

This runtime does not support a 10-GB D1 database. Before every export and on
every hourly freshness tick, it queries live D1 metadata and requires
`file_size` to be a positive safe integer strictly below
`BACKUP_MAX_SOURCE_BYTES`. A zero live size fails retryably before export
readiness so a later scheduled retry or restart can recover once metadata is
positive. The checked-in default and deployment value are 4,500,000,000 bytes,
below R2's 5-GiB single-object limit. Configuration may lower this ceiling but
cannot raise it. Reaching the ceiling fails export readiness and hourly
observability before an export starts. The signed export download is
independently rejected if its `Content-Length` is zero or at or above 5 GiB.
Zero-byte rejection is retryable: the upload callback refreshes the bookmark URL
and retries without storing or manifesting the empty response.

Multipart capture and statement-safe split restore are not implemented. A
database or logical SQL export above these limits is unsupported and cannot be
reported ready.

## Credential contract

The source export token requires Cloudflare Account D1 Edit. Cloudflare grants
that permission account-wide and it can mutate D1; the Worker's application
UUID/name allowlist reduces operator mistakes but does not technically scope the
token to one database or make it read-only.

Keep the source runtime token separate from destination R2 provisioning and
lock-administration credentials and from drill restore credentials. The Worker
receives only the source token as `CLOUDFLARE_API_TOKEN` and destination object
read/write access through `BACKUP_BUCKET`; it must not receive either
administrative or restore credential.

Set `BACKUP_MANIFEST_SIGNING_KEY_ID`,
`BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64`,
`TRUSTED_RESTORE_BASELINE_ID`, and `TRUSTED_RESTORE_BASELINE_SHA256` as reviewed
non-secret vars. The verifying key is the base64-encoded Ed25519 SPKI public
key; hourly freshness verifies the canonical manifest payload against it and
treats invalid signatures or key configuration as stale. Set
`BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64` only as a Worker secret; it
is base64-encoded Ed25519 PKCS#8 private key material and must never appear in
Wrangler config, logs, manifests, evidence, or signed URLs.

The 02:15 UTC trigger normally creates the day's deterministic instance for
every entry in `SOURCE_DATABASES` (APP_DB `kody` and JOBS_DB `kody-jobs`;
instance id `d1-backup-<databaseId>-<day>`). When `SOURCE_DATABASES` is unset,
only `SOURCE_DATABASE_ID` is exported. Freshness uses the previous UTC day
before 02:15 and the current day from 02:15 onward, so the 02:45 tick cannot
report yesterday as success for a failed current backup. Freshness ticks from
02:45 through 05:45 UTC use the same deterministic ids and canonical 02:15
payloads to create a missed instance or restart an errored or terminated
instance. Active and complete instances are left alone, and no retry tick
outside that bounded window creates an instance. Freshness inspection and
enqueue/restart run as independent settled lanes, so a transient D1 metadata
failure cannot skip the approved-window recovery attempt; the scheduled event
still fails afterward to preserve alerting. Exhausting the 120-poll export
window is terminal for that Workflow execution; the next approved tick restarts
it with fresh Workflow step state and a new export rather than replaying the
cached pending poll sequence. Hourly freshness is stale unless every configured
database is fresh.

The operator **Seal day** action enqueues workflow `kody-production-seal-day`
(instance id `seal-day-<day>`) and redirects to `/seal-status`. The hourly
`sealRecentCompleteDays` scan on the freshness cron is a synchronous
`sealFullBackupDay` call.

## Deploy

GitHub Actions deploys this Worker to the DR Cloudflare account from
`.github/workflows/deploy.yml` (`deploy-backup-control-plane`) when
`packages/backup-control-plane/` or `packages/shared/src/backup-*` change on
`main`. Requires repository secrets `DR_DEPLOY_TOKEN` and
`DR_BACKUP_ACCOUNT_ID`. Manual/emergency:

```sh
CLOUDFLARE_ACCOUNT_ID=<DR_ACCOUNT_ID> \
  CLOUDFLARE_API_TOKEN=<DR_DEPLOY_TOKEN> \
  npm run backup:deploy -- --var "BUILD_COMMIT:$(git rev-parse HEAD)"
```

Worker secrets (`CLOUDFLARE_API_TOKEN`, `DRILL_API_TOKEN`, signing key, restore
secrets) are not synced by that job — set them once with Wrangler / the
Cloudflare dashboard.

## Integrity checks

The hourly freshness check compares the immutable object's R2 size and ETag to
the canonical manifest and requires restorable SQL statement stats for new
backup days. Run a separate periodic restore drill that downloads the object,
verifies its SHA-256 against the manifest, and restores it into a non-production
D1 database. The metadata freshness check is not a replacement for that deep
checksum and restore drill.
