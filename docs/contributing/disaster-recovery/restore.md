# Disaster recovery restore and drills

The Admin UI, drills, graduated production restore, Durable Object point-in-time
recovery, and Mailbox re-import. Start at the
[disaster recovery index](../disaster-recovery.md).

## Admin UI

Routes (all require Access JWT):

| Method | Path                       | Action                                                                                                                                                                                      |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                        | Dashboard: enable gates, source identity, live D1 size, escrow presence, 14-day D1/staging/seal status with signature verification                                                          |
| `POST` | `/actions/seal-day`        | Enqueue workflow `kody-production-seal-day` for that day (`seal-day-<day>`), then redirect to its status page.                                                                              |
| `POST` | `/actions/run-paced-drill` | Enqueue an [isolated paced restore drill](#isolated-restore-drill) and redirect to `/paced-drill-status?id=`                                                                                |
| `GET`  | `/paced-drill-status?id=`  | Live paced drill readout: per-source progress, per-table manifest, imported and target row counts, manifest and target checksums, and PASS or FAIL. Refreshes every 5 seconds while running |
| `POST` | `/actions/restore/prepare` | Validate sealed day; issue 10-minute HMAC confirm token                                                                                                                                     |
| `POST` | `/actions/restore/execute` | Require typed exact `SOURCE_DATABASE_NAME` + valid token; start restore Workflow                                                                                                            |
| `GET`  | `/seal-status?id=...`      | Poll seal Workflow status (in progress, sealed, already sealed, or incomplete reason)                                                                                                       |
| `GET`  | `/restore-status?id=...`   | Poll restore Workflow status                                                                                                                                                                |

### Force a paced full base

`POST https://kody.codes/__maintenance/dr-paced-force-full-base?day=YYYY-MM-DD`
with `Authorization: Bearer $DR_RESTORE_SECRET` makes the paced lane cut a full
base for that night instead of deltas. Use it when a restore drill needs a base
newer than the last Sunday. `day` must be today or tomorrow (UTC), and the
request is refused with 409 once any paced source has started that night. The
night keeps its weekday `daily` tier, and later delta nights chain back to it.

### Agent seal API (`DR_OPS_SECRET`)

Headless agents enqueue seal workflows without the Access-protected HTML UI.
These routes live on the DR control plane origin (for example
`https://kody-dr.kentcdodds.com`). The
[Worker's agent-route handler](../../../packages/backup-control-plane/dr-ops-maintenance.ts)
checks `Authorization: Bearer $DR_OPS_SECRET` and dispatches seal enqueue, seal
status, and paced drill status.

Reachability is separate from bearer auth: Cloudflare Access on
`kody-dr.kentcdodds.com` still applies unless the request includes a valid
Access service-token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) or Kent
excludes `/__maintenance/*` from the Access application
([#2477](https://github.com/kentcdodds/kody/issues/2477)). The bearer alone
cannot bypass edge Access.

| Method | Path                                    | Action                                                                                                                                              |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/__maintenance/dr-seal`                | JSON `{ "day": "YYYY-MM-DD" }` — enqueue `kody-production-seal-day` (`seal-day-<day>`)                                                              |
| `GET`  | `/__maintenance/seal-status?id=`        | JSON seal workflow status (`describeSealStatus` view) for `seal-day-YYYY-MM-DD` ids                                                                 |
| `GET`  | `/__maintenance/paced-drill-status?id=` | JSON isolated paced drill progress (status, per-source phase and units, per-table rows, checksums and result) for `paced-drill-YYYY-MM-DD-<ms>` ids |

### Isolated restore drill

The UI selects the most recent day in the last week with a sealed paced night
for every `D1_PACED_SOURCES` database. Before making D1 requests, the drill
[checks that `DRILL_ACCOUNT_ID` differs from `SOURCE_ACCOUNT_ID`](../../../packages/backup-control-plane/restore-drill.ts).
For each source the
[drill Workflow](../../../packages/backup-control-plane/paced-restore-drill.ts)
creates a fresh drill database in the drill account, replays the sealed base and
deltas, runs `PRAGMA quick_check`, and verifies each table's row count and
checksum against the tip manifest. It deletes databases that pass and leaves
created databases on failed runs available for inspection. This drill covers D1
only; see [Offline CLI fallback](./offline-cli.md) for the separate SQL-export
drill.

### Graduated production restore

1. **Prepare** —
   [sealed-day validation](../../../packages/backup-control-plane/production-restore.ts)
   verifies the full manifest signature and each referenced paced manifest's
   expected R2 key and SHA-256. The UI shows the source names and issues a
   10-minute confirm token.
2. **Execute** — the
   [execute route](../../../packages/backup-control-plane/control-plane-fetch.ts)
   requires a valid confirm token and the exact primary production database name
   (`SOURCE_DATABASE_NAME`, APP_DB `kody`). Workflow
   `kody-production-dr-restore` revalidates the day, then plans and preflights
   every paced chain in the sealed day's `d1Paced` list
   [before starting any safety export](../../../packages/backup-control-plane/production-restore.ts).
   It saves a D1 SQL safety export for each target under
   `pre-restore/{day}/{databaseId}/`; the
   [export poller](../../../packages/backup-control-plane/d1-export-api.ts)
   polls pending bookmarks and restarts expired exports within its attempt
   limits. The Workflow replays each paced chain, with APP_DB last, and verifies
   table counts and checksums plus `PRAGMA quick_check`. It then loops chunked
   `POST {PRIMARY_WORKER_ORIGIN}/__maintenance/dr-restore` with
   `Authorization: Bearer {DR_RESTORE_SECRET}` until the production worker
   reports `done` (StorageRunner replace, R2 put, published snapshot KV put).
3. **Mailbox re-import** — with ingress still disabled, run the automated
   Mailbox importer below for the intended owners. Do not re-enable ingress
   unless its final response has both `"done": true` and `"verified": true`.

Graduated production restore is the disaster path only. Never run it against the
live databases as a validation or on a schedule: the isolated paced restore
drill exercises the same plan, import, and verification helpers
([paced target restore](../../../packages/backup-control-plane/paced-d1-target-restore.ts))
against fresh databases in `DRILL_ACCOUNT_ID`.

Put the app in [maintenance mode (edge)](./maintenance-mode.md) before execute.
After restore: reindex Vectorize (`POST /__maintenance/reindex-capabilities`
with `{ "force": true }`, omit `phases`, follow `cursor` until `complete`); let
`kody-jobs` re-arm JobManager Durable Object alarms from restored `JOBS_DB`
(`jobs.next_run_at` via `JobManager.syncAlarm` and the jobs-worker watchdog —
APP_DB is not the job schedule store); recreate queues from Wrangler config; and
expect users to reauthorize OAuth and reconnect MCP servers.

### Durable Object point-in-time recovery

Use Durable Object (DO) PITR for an application bug or corruption inside one
**surviving** SQLite-backed object. It restores that object's complete SQLite
database, including SQL tables and key-value storage, to an approximate point
within Cloudflare's rolling 30-day history. It is not a replacement for sealed
backups: if an object or its class was deleted, use backup media where that
class is covered. Deleting a Durable Object class destroys its PITR history and
makes this procedure impossible.

The operator endpoint is production-only infrastructure, is not registered on
user, MCP, or package surfaces, and reuses `DR_RESTORE_SECRET`. Put the app in
[maintenance mode (edge)](./maintenance-mode.md) or otherwise stop writes to the
affected user before recovery. Supply the user's exact `stable_user_id`, not
username, email, or a D1 numeric id. Valid `kind` values are `mailbox`,
`run-log`, `user-meter`, and `storage-runner`; `storage-runner` also requires
its exact storage id.

1. Resolve a bookmark for the incident timestamp. Cloudflare returns the
   bookmark nearest that time:

   ```sh
   USER_ID='EXACT_STABLE_USER_ID'
   INCIDENT_AT='YYYY-MM-DDTHH:MM:SSZ'
   INCIDENT_TIMESTAMP_MS="$(
     node -e 'const ms=Date.parse(process.argv[1]);if(!Number.isFinite(ms))process.exit(1);console.log(ms)' \
       "$INCIDENT_AT"
   )"
   curl --fail-with-body \
     --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/do-pitr" \
     --header "Authorization: Bearer $DR_RESTORE_SECRET" \
     --header "Content-Type: application/json" \
     --data @- <<JSON
     {
       "operation": "get-recovery-bookmark",
       "kind": "mailbox",
       "userId": "$USER_ID",
       "timestampMs": $INCIDENT_TIMESTAMP_MS
     }
   JSON
   ```

   For StorageRunner, add `"storageId": "EXACT_STORAGE_ID"`. Keep the returned
   `bookmark` in the incident record and inspect it before the destructive step.

2. Schedule the restore. The object logs the undo bookmark as a structured
   `do-pitr-restore-scheduled` event, returns it as `undoBookmark`, and resets
   immediately so the next object session applies the restore:

   ```sh
   BOOKMARK='BOOKMARK_FROM_STEP_1'
   curl --fail-with-body \
     --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/do-pitr" \
     --header "Authorization: Bearer $DR_RESTORE_SECRET" \
     --header "Content-Type: application/json" \
     --data @- <<JSON
     {
       "operation": "restore-to-bookmark",
       "kind": "mailbox",
       "userId": "$USER_ID",
       "bookmark": "$BOOKMARK"
     }
   JSON
   ```

   Copy `undoBookmark` immediately and verify the affected object's state before
   restoring ingress. The operator log (`event=do-pitr-operator-restore`)
   includes the operation id, exact object identity, target bookmark, and undo
   bookmark. PITR is unavailable in local development and Workers unit-test
   emulation; the endpoint reports `pitr-unavailable` there.

3. To undo the recovery, repeat step 2 against the same exact object identity,
   using the saved `undoBookmark` as `bookmark`. The undo itself returns a new
   undo bookmark; retain that handle too. Do not assume logs from the restored
   object's own historical storage contain the handle—the structured platform
   log and the operator response are the recovery record.

### Automated Mailbox re-import

`POST /__maintenance/dr-mailbox-import` is the normal recovery path after
object/class/account loss. It is `DR_RESTORE_SECRET`-gated, verifies the sealed
full-manifest signature, verifies the mailbox index bytes and SHA-256, and
verifies each selected owner's dump parts before writing that owner (see the
[media verifier](../../../packages/worker/src/dr/mailbox-import-media.ts) and
[importer](../../../packages/worker/src/dr/mailbox-importer.ts)). It reads and
parses one part at a time, checks for duplicate IDs and missing references
across parts, then rereads the parts needed for each write phase. Each tick
writes parent threads, then messages with attachments through
`upsertMessageGraph`, then delivery events through `upsertDeliveryEvents`.
Returned cursors are authenticated and bound to the day, owner selection,
conflict policy, and drill flag; repeat the same request with `cursor` until
`done`.

Keep ingress disabled and complete the signed D1 plus R2 restore first. Select
specific stable owner ids with an array, or explicitly select every index owner
with `"all-from-index"`:

```sh
set -euo pipefail

DAY='YYYY-MM-DD'
CURSOR=''
while :; do
  BODY="$(
    DAY="$DAY" CURSOR="$CURSOR" node -e '
      const body = {
        day: process.env.DAY,
        owners: "all-from-index",
        conflictPolicy: "refuse",
      }
      if (process.env.CURSOR) body.cursor = process.env.CURSOR
      process.stdout.write(JSON.stringify(body))
    '
  )"
  if ! RESPONSE="$(
    curl --fail-with-body --silent --show-error \
      --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/dr-mailbox-import" \
      --header "Authorization: Bearer $DR_RESTORE_SECRET" \
      --header "Content-Type: application/json" \
      --data "$BODY"
  )"; then
    printf 'mailbox import request failed; stopping\n%s\n' "$RESPONSE" >&2
    exit 1
  fi
  printf '%s\n' "$RESPONSE"
  DONE="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.done===true))' "$RESPONSE")"
  if [ "$DONE" = true ]; then
    break
  fi
  if ! CURSOR="$(node -e 'const x=JSON.parse(process.argv[1]);if(!x.nextCursor)process.exit(1);process.stdout.write(x.nextCursor)' "$RESPONSE")"; then
    printf 'response is not done and has no nextCursor; stopping\n' >&2
    exit 1
  fi
done
```

The default conflict policy refuses an owner whose target Mailbox is non-empty.
Destructive replacement requires both `"conflictPolicy": "replace"` and the
separate exact confirmation
`"replaceConfirmation": "PURGE NON-EMPTY TARGET MAILBOXES"`. The importer never
calls `purge` without both. Review that change to the request as a destructive
restore step; keep the same fields on every resumed request. Before purging a
non-empty target, the importer first replays and count-verifies the complete
dump through a reserved scratch preflight object. Preflight and drill writes do
not arm normal Mailbox alarms; a verified production target is finalized only
after count parity succeeds.

For a drill, use explicit owner ids and add `"drill": true`. The importer
derives reserved scratch owner ids under `__mailbox-drill__:` and rewrites only
owner-bound blob references for those scratch objects; it never opens the real
owners' Mailbox objects. A successful drill still verifies the signed media,
exercises every graph upsert, and requires per-kind `countMailbox` parity. Drill
objects are inert test data and do not imply that their rewritten blob keys
exist. After collecting the per-kind count result, the importer atomically
purges all imported mail rows and retains only a non-sensitive count marker for
idempotent replay; cleanup failure fails the operation so a full mail copy
cannot be left silently. Use the same separately confirmed replace policy only
when recovering a scratch object left by an interrupted older run.

Every completed owner appears in `ownerResults` with expected and actual thread,
message, attachment, and delivery-event counts. Any mismatch leaves
`"verified": false` and is also reported in `warnings`; this operation never
enables ingress. Once target writes begin, normal Mailbox reads remain blocked
until count parity finalizes that owner; a failed or mismatched owner stays
blocked for safe operator recovery. Preserve all responses in the incident
record.

### Manual Mailbox re-import (fallback)

Prefer
[Durable Object point-in-time recovery](#durable-object-point-in-time-recovery)
when the Mailbox object survives and the target is still inside Cloudflare's
30-day history. If the automated importer is unavailable, use this procedure as
the correctness spec and incident-only fallback:

1. Keep ingress disabled and complete the signed D1 plus R2 restore first, so
   every raw MIME and external-attachment key referenced by Mailbox rows exists.
2. Verify the full-manifest signature and the sealed mailbox-index byte count
   and SHA-256. For every owner entry, verify the NDJSON object's byte count and
   SHA-256 before reading any rows. Do not mutate production during a manual
   drill.
3. Build and review an incident-only maintenance command from the restored
   commit. For each `ownerId`, stream that owner's dump into a new or confirmed
   empty `Mailbox` object. Recreate threads and messages with their attachments
   through `upsertMessageGraph`, then delivery events through
   `upsertDeliveryEvents`. Preserve the exported ids and timestamps, process
   parents before children, and never call `purge` on an existing object without
   a separately reviewed destructive-restore plan.
4. Compare `countMailbox` with the dump's per-kind counts, then spot-check
   inbound raw MIME and external attachments through normal reads. Re-enable
   ingress only after every intended owner passes.
