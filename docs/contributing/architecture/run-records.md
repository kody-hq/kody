# Run records

Kody records what each runtime surface ran and how it ended so users (and their
agents) can debug failures without scanning platform logs. This document
describes the contract, the per-user Durable Object store, persistence policy,
retention, and the recipe for instrumenting a new surface.

Deliberately out of scope: Analytics Engine aggregates (see
[Usage metering](./usage-metering.md)), Sentry platform alerts, and D1 job
schedule/retention anchors (`jobs.last_run_at` / `last_run_status` — not
last-run error, duration, or counters). Those neighbors are covered in
[Neighboring systems](#neighboring-systems).

## What a run record is

A run record is one execution attempt on a named **surface**: status (`running`
/ `success` / `error`), optional package/job/workflow identifiers, start and
finish timestamps, duration, truncated error fields, optional soft error triage
(`error_triage`: `ignored` / `resolved`, plus note / who / when — separate from
execution status), who started the run (`started_by`: person id / handle +
client such as MCP, CLI, API token, schedule, or webhook — the interactive
caller or the enablement owner; `null` only when neither an explicit
`context.startedBy` nor request-derived attribution exists), JSON metadata, and
up to 200 captured log lines.

Package ownership is optional. Ad-hoc MCP `execute` and inline workflows have no
`package_id`; the record still lands under the signed-in user. That optionality
is why run records are not shaped as package-scoped debug rows.

Code lives in `packages/worker/src/run-records/` (types, worker service, and the
`RunLog` Durable Object). MCP capabilities live under
`packages/worker/src/mcp/capabilities/runs/` (list/get/summary plus soft triage
via `runUpdate`). The account UI is `/@<slug>/-/activity`.

## Surfaces

| Surface        | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `execute`      | Ad-hoc MCP `execute` sandbox evaluation                        |
| `export`       | Saved-package export invocation                                |
| `subscription` | Package subscription handler dispatch                          |
| `app_fetch`    | Package app HTTP fetch handler                                 |
| `app_realtime` | Package app realtime websocket session                         |
| `job`          | Scheduled or manually triggered job execution                  |
| `workflow`     | Cloudflare Workflow run (`DynamicCallableWorkflow`)            |
| `webhook`      | Authenticated inbound webhook delivery (and post-auth rejects) |

The closed union is `RunSurface` in `packages/worker/src/run-records/types.ts`.
Add new members there — never invent ad hoc surface strings at call sites.

## Persistence policy

`runPersistenceForSurface(surface)` returns **`eager` for every surface**,
including `export`. A `running` row is written at begin so an evicted or hung
run is still visible in history, and both success and error persist. Ad-hoc
`execute` is eager with or without an `idempotencyKey`, so successful one-off
executes show up in Activity the same way jobs and webhooks do.

`runPersistenceForContext(context)` is what begin/finish actually use. It
matches that surface default, except **key-less `export` downgrades to
`on-failure`**: nothing is persisted unless the run ends in `error`.

Key-less package export stays on-failure because it is the lean hot path: the
caller already holds the result inline, and the user-visible history is the
parent execute, job, webhook, or app run. An execute `idempotencyKey` does not
change persistence. It claims the row so a client timeout can poll `runGet` or
retry the same key. Success counts for every surface, including ad-hoc execute,
also land in Analytics Engine via [usage metering](./usage-metering.md).

Hosted MCP clients time out at about 60 seconds (JSON-RPC `-32001`) while the
sandbox can still be running. Hosted `execute` returns before that deadline with
`inProgress: true`, `runId`, and `idempotencyKey` (server-assigned when the
caller omitted one) and leaves the sandbox running. The caller polls `runGet` or
retries `execute` with that key. A caller abort before that follow response
still stops the sandbox and finishes the run as `errorName=client_disconnected`.
Retrying that same key replays the disconnect error (or the retained result
after a normal finish). Retrying while the first attempt is still running
returns `inProgress: true` without starting a duplicate sandbox. Keyed package
invocations write `package invocation started: …` in the claim RPC, before
sandbox work, so an isolate killed before finish still leaves a diagnostic line
when reconciliation later marks `platform_interrupted`.

## Begin / finish contract

```ts
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'

const handle = beginRunRecord({
	env,
	userId,
	context: {
		surface: 'job',
		name: job.name,
		jobId: job.id,
		// packageId / kodyId optional
		// startedBy optional; begin stamps it from `request` when omitted
	},
	request, // optional live RequestContext
	startedByLabel, // optional display label (API token name); never a secret
	waitUntil, // optional; preferred when ExecutionContext is available
})

try {
	// … do the work …
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs,
	})
} catch (error) {
	await finishRunRecord({
		env,
		handle,
		status: 'error',
		logs,
		error,
	})
	throw error
}
```

Rules:

- **`beginRunRecord` is synchronous and non-blocking.** For `eager` surfaces it
  fire-and-forgets `startRun` (optionally via `waitUntil`). It returns a handle
  that already carries a minted run id, `startedAt`, persistence mode, and the
  full context — or `null` when there is no user / no `RUN_LOG` binding /
  missing context. Pass the live `request` (and optional `startedByLabel`) so
  begin can stamp `started_by` when `context.startedBy` is omitted; without a
  request or explicit stamp, Activity shows the run as unknown. Callers that
  reach begin through a WorkerEntrypoint RPC (package-app isolates:
  `packageRuntimeRunStart`) must not await that RPC on the HTTP/realtime
  response path — kick it off, run user code, and `waitUntil` begin-then-finish.
  A dropped `running` insert is still harmless because finish upserts the
  terminal row.
- **`finishRunRecord` awaits the complete-row upsert in one RPC** (`finishRun`),
  then replaces logs and enforces retention. A supplied `waitUntil` applies only
  to post-terminal observers such as `run.error.recorded`, never to the terminal
  write itself. A dropped `running` insert is harmless: finish still writes the
  terminal row. That is why begin can stay off the request critical path.
- **`on-failure` + `success` is a no-op** at finish (no DO write).
- Finish **never throws into the observed path**. Sink failures log a warning.
  It resolves `true` when the terminal write succeeds (or persistence is not
  required by policy) and `false` when no terminal row was written.
- Finish may accept an optional JSON-serializable **`result`**. When present it
  is stored under `metadata.result` after a bounded snapshot
  (`runRecordMaxResultSnapshotBytes`, currently 4 KiB). Oversized values become
  `{ __truncated__: true, preview }`. Eager surfaces that produce a handler
  return value (at minimum webhook deliveries, package exports, and ad-hoc
  execute) should pass it so `runGet` can show what the handler returned.
- Ad-hoc **execute** runs (MCP tool and in-runtime `meta.execute`) stamp
  forward-only attribution in metadata: `entry` (`code`) and `workerId` (the
  stable LOADER id unique_worker_days already meters) once the module graph is
  minted. Older rows may carry `entry: invoke` plus an `invoke` specifier from
  the removed execute shortcut
  ([ADR 0085](../decisions/0085-execute-takes-code-only.md)); readers keep
  showing them. Package columns (`package_id`, `published_commit`, …) stay
  first-class. `published_commit` is the bundle that executed, which can trail
  `entity_sources.published_commit` for a short npm-backed republish window
  (bounded by the published source snapshot `createdAt`, not
  `entity_sources.updated_at`). No historical backfill.
- Keyed execute claims the idempotency key through `claimRunRecord` (awaited DO
  RPC) before sandbox work so a concurrent retry sees `running` or the terminal
  row instead of starting a second attempt. Lookups are scoped by
  `(surface, idempotency_key)` so execute keys cannot collide with
  package/workflow history. Claim is select-then-insert inside one DO RPC
  (serialized), not a unique SQL constraint — other surfaces may reuse
  idempotency keys across history. Setup failures before sandbox work
  `abandonRunRecord` (delete if still `running`) so keys are not poisoned.
- Bundled-module runners (`runBundledModuleWithRegistry`) accept a `runRecord`
  context (and an optional pre-claimed `runRecordHandle`) and call begin/finish
  internally; surfaces that do not go through that helper call the service
  directly (webhooks, package apps, and similar).

## Per-user Durable Object

Records live in a per-user `RunLog` Durable Object with SQLite (`runs` and
`run_logs` tables). One DO per user:

```ts
runLogDurableObjectName(userId) // → idFromName(userId)
```

There is deliberately **no `user_id` column** inside the DO. The object identity
_is_ the user, so cross-user reads are structurally impossible: a caller that
passes the authenticated `userId` can only open that user’s stub. Binding name:
`RUN_LOG` (class `RunLog`).

This satisfies the repo-wide per-user isolation invariant the same way
`JobManager` and `McpClientHub` do — by namespacing Durable Object identity —
rather than by filtering a shared table.

## Why not D1

Run records are per-event writes. D1 is a single shared writer for the whole
deployment. Putting every execute failure, job run, webhook delivery, and
service wake on that writer would serialize unrelated user traffic — the same
reason usage metering writes Analytics Engine data points instead of upserting
D1 per event (see [Usage metering](./usage-metering.md) § Sinks). Per-user DO
SQLite keeps write contention on the user who produced the events. That is the
`no-per-event-shared-writes` invariant: per-event writes go to Analytics Engine
or per-user DO SQLite, never the shared D1 writer.

## Retention

Enforced **inside the DO on every `finishRun`**, not by a global cron lane over
a shared D1 table:

| Cap                        | Value                                           |
| -------------------------- | ----------------------------------------------- |
| Age                        | ~30 days (`runRecordRetentionDays`)             |
| Count                      | 2,000 runs per user (`runRecordMaxRunsPerUser`) |
| Log lines per run          | 200                                             |
| Text / JSON field budgets  | 16 KiB / 32 KiB truncated                       |
| `metadata.result` snapshot | 4 KiB (`runRecordMaxResultSnapshotBytes`)       |
| Stale `running` (short)    | ~3 minutes for execute/export/subscription/…    |
| Stale `running` (webhook)  | ~10 minutes (2× the 5-minute background budget) |
| Stale `running` (job)      | ~6 hours                                        |
| Stale `running` (long)     | ~24 hours for service/workflow                  |

Age prune deletes finished runs older than the cutoff (rows still `running` are
kept). Count prune deletes the oldest excess rows in three lanes: handled
(`ignored` / `resolved`) errors first, then successes, then open errors. This
makes soft triage relieve duplicate-error saturation while preserving useful
success history and keeping active failures strongest. Orphan log lines are
cleaned in the same pass. Caps are applied in small batches per finish so a
single RPC stays bounded.

The retention alarm is one-shot at the next due-time (oldest finished + age,
oldest in-flight + surface stale TTL, or now when over-cap **and** a terminal
row is evictable). Over-cap with only `running` rows is not treated as due now.
An empty pass (deleted no run rows) that would otherwise wake immediately backs
off from 15s, doubling to a 15-minute cap, instead of rescheduling every 1s. A
later start or finish resets that backoff.

Stranded `running` rows (isolate reset, lost `waitUntil` finish, hung Worker
Loader `evaluate`) are reconciled to `status=error` with the stable
`errorName=platform_interrupted`. This name means platform weather ended the
host execution and its outcome is unknown; Activity, `runList`, and triage
automation must not classify it as a user-authored package failure.
Reconciliation uses the surface-aware TTLs above and runs on the DO alarm and on
retention passes. Readers heal only the row they already loaded (`getRun`, keyed
lookup, and each `listRuns` page row) so Activity and keyed-execute recovery do
not wait for an alarm. `summarize` does not reconcile — it counts current rows
and reuses a same-isolate memo for the same `since` minute.

Interrupted scheduled-job occurrences (`idempotency_key` beginning
`scheduled-job:`), keyed subscription deliveries, and keyed package-export
invocations are retained with `error_triage=ignored` because their scheduler,
delivery queue, or webhook caller retries the same idempotent unit. Manual jobs,
keyed execute calls, and other surfaces stay open: their caller may need to
recover or act on the unknown outcome. A later terminal finish still replaces
the reconciled row when the outcome becomes known.

## Keyed package-invocation idempotency ledger

The same per-user `RunLog` DO also hosts the **keyed package-invocation
idempotency ledger** (`package_invocation_ledger` table). This is correctness
state, not observability: it holds the claims and bounded replay responses that
keyed package-export runs dedupe against. Unlike run history it cannot be
rebuilt — a lost terminal row means a replayed delivery for that key re-executes
instead of replaying.

- **Claim + run-record begin are one awaited DO RPC**
  (`claimPackageInvocation`): lookup-then-insert is atomic because DO execution
  is serialized, and the eager `running` run row is written in the same call.
  Stale `in_progress` claims (15 minutes, matching request hash) are reclaimed
  in place.
- **Terminal response + run-record finish are one awaited DO RPC**
  (`finishPackageInvocation`): the bounded replay response (restore-safe byte
  ceiling) and the terminal run row land together; the ledger update is fenced
  on the claim timestamp so a competing reclaim cannot be overwritten. If that
  RPC fails after package code completed, the caller receives
  `idempotency_persistence_failed` rather than a false success. Durable callers
  retry the same key; the live claim prevents duplicate execution while the
  terminal result is unresolved.
- **Ledger retention is DO-local**: terminal rows keep replay responses for 90
  days (`packageInvocationLedgerRetentionDays`), pruned by the same retention
  passes and alarm as run rows; `in_progress` rows are never pruned. There is no
  D1 ledger or D1 sweep for this state.
- **The DO is the only store**: the keyed path performs no D1 ledger reads or
  writes; the current schema in
  `packages/worker/migrations/0001-squashed-init.sql` has no D1
  `package_invocations` table. Only keys claimed in this DO ledger can replay; a
  redelivery for an unknown key executes fresh. Delivery-id webhook replays pass
  `idempotencyParamsHash: 'ignore'` so the ledger returns the retained response
  by key even when `receivedAt` (and the rest of the hashed params) differ.
- Account export pages ledger rows through the same `run_records` section cursor
  (runs first, then ledger rows, then dedicated unpruned state); account
  deletion purges them with `clearAll` (every DO table, then schema
  reinitialization). Disaster recovery deliberately does not stage the DO —
  losing it risks duplicate execution of replayed webhooks (see
  [disaster recovery](../disaster-recovery.md)).

## Invariant: state vs history

Entity rows hold **current state**. Run records hold **history**. Jobs keep
schedule metadata and `last_run_at` / `last_run_status` on the D1 `jobs` row;
last-run error, duration, and counters for observability live in RunLog
`job_run_observability` and survive run-history pruning. Package activation
counters and milestones live in the same DO (`package_run_successes`,
`activation_milestones`).

## Recipe: instrumenting a new surface

Modelled on the
[usage-metering chokepoint recipe](./usage-metering.md#recipe-instrumenting-a-new-chokepoint).

1. **Pick the semantic unit.** One run record per user-visible attempt (one job
   execution or one webhook delivery). Nested layers may each record their own
   surface; do not double-write the same surface for one unit.
2. **Add the `RunSurface` member** to `runSurfaceValues` in
   `packages/worker/src/run-records/types.ts` if it does not exist. Choose
   persistence in `runPersistenceForSurface` (`eager` unless the caller already
   holds the full success result inline and volume is high — then consider
   `on-failure` and document why).
3. **Begin as soon as you have `userId` and context**, before the work that can
   fail:

   ```ts
   import {
   	beginRunRecord,
   	finishRunRecord,
   } from '#worker/run-records/service.ts'

   const handle = beginRunRecord({
   	env,
   	userId,
   	context: {
   		surface: 'my_surface',
   		name: entityName,
   		packageId, // optional
   		metadata: {/* small, non-secret */},
   	},
   	request, // stamps started_by when context omits it
   	waitUntil: ctx.waitUntil.bind(ctx),
   })

   let status: 'success' | 'error' = 'success'
   let error: unknown
   const logs: Array<string> = []
   try {
   	// existing work; push console-equivalent lines into logs when available
   } catch (cause) {
   	status = 'error'
   	error = cause
   	throw cause
   } finally {
   	await finishRunRecord({ env, handle, status, logs, error })
   }
   ```

   If the path already goes through `runBundledModuleWithRegistry`, pass
   `runRecord: { surface, … }` instead of calling begin/finish yourself.

4. **Do not put secrets in metadata or logs.** Truncation helpers already bound
   size; redaction is still the caller’s job.
5. **Do not change behavior.** Recording must not alter return values or add
   critical-path latency beyond the awaited finish RPC (begin stays
   fire-and-forget).
6. **Keep state updates on the entity.** For jobs, update RunLog
   `job_run_observability` (error, duration, counters) and D1 schedule fields
   plus `last_run_at` / `last_run_status` retention anchors — not pruned run
   history. Other surfaces may update a dedicated state table when they have “is
   it running?” semantics — never teach entitlements or UI to infer that from
   run history.
7. **Test it.** Prefer a `*.workers.test.ts` against the real `RUN_LOG` binding
   (see `packages/worker/src/run-records/run-records.workers.test.ts`), or spy
   on `beginRunRecord` / `finishRunRecord` in Node unit tests the way usage
   metering spies on `recordUsage`.

## Neighboring systems

| System                          | Answers                                       | Store                                                                    |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| **Run records** (this doc)      | What failed, with logs, for one user’s runs   | Per-user `RunLog` DO SQLite                                              |
| **Usage metering**              | How many / how long / aggregate cost pressure | Analytics Engine + D1 `usage_rollups`                                    |
| **Sentry**                      | Platform defects operators should fix         | Sentry project                                                           |
| **Entity state columns/tables** | Current job status and counters               | RunLog `job_run_observability`; D1 `jobs` schedule and retention anchors |
| **Package subscriptions**       | Same-user reaction to terminal errors         | Best-effort dispatch after `finishRun`                                   |

After a successful terminal `finishRun` with `status: 'error'`,
`finishRunRecord` best-effort dispatches `run.error.recorded` to the owning
user’s packages that declare the topic (see
`packages/worker/src/run-records/package-subscriptions.ts` and
[Package subscriptions](../../guides/package-subscriptions.md)). Emission skips
`surface === 'subscription'` so a failing notifier cannot recurse. Discovery and
invocation infrastructure failures are warned, never thrown into the observed
run path. There is no Queue for this topic.

**Usage metering** and run records are the aggregates/records pair: metering is
sampling-tolerant and quota-oriented; run records are user-facing history.
Ad-hoc `execute` successes are retained as run records and counted in metering.
An idempotency key on execute is what makes a timed-out client able to replay
that same result.

**Sentry** must not open issues for user-authored failures. Boundaries that know
the code is user-supplied throw `UserCodeError`
(`packages/worker/src/user-code-error.ts`). Sentry `beforeSend`
(`filterSentryEvent` in `packages/worker/src/sentry-options.ts`) drops events
when `isUserCodeError(hint.originalException)` — including nested causes.
String-match filters for bundler failures and sandbox timeouts remain only as
backstops for unmarked paths. Run records still store those failures for the
user.

**Entity state** stays on the entity (or its dedicated projection table). Job
last-run error, duration, and counters live in RunLog `job_run_observability`;
D1 `jobs` keeps schedule fields and `last_run_at` / `last_run_status` as
retention anchors only. History browsers (`/@<slug>/-/activity`, `runList` /
`runGet` / `runSummary`) read `RunLog`.

## Soft error triage

Execution `status` stays `running` / `success` / `error`. Retained **error**
rows may also carry soft triage (`error_triage`: `ignored` | `resolved`, plus
optional `triage_note`, `triaged_at`, `triaged_by`). Triage is non-destructive:
error name/message/logs stay put; Activity's Open errors view and `runList`
default to `error_triage=open` so handled noise drops out of the default view;
Activity's Recent runs view lists the last 7 days with `error_triage=all`;
`runSummary.errors` counts only open errors and exposes separate `ignored` /
`resolved` totals. Terminal `finishRun` upserts preserve triage on error
finishes and clear it if a row somehow finishes non-error. A later successful
run for the same immutable `job_id` automatically soft-resolves prior open
errors for that job with `triaged_by=system:auto-resolve`; ignored errors are
not overwritten, and every resolved row keeps `status=error` plus its original
error details. Auto-resolution is intentionally job-only: names on other
surfaces are not uniformly immutable identities.

`runUpdateBulk` is the bounded operational relief valve. It selects up to 100
error rows either by explicit run ids or exact-match filters (`surface`,
`package_id`, `job_id`, `name`, `error_name`, `error_message`, and current
triage). Filters must contain at least one identity/error field; filtered reopen
requires an explicit ignored/resolved source state. `dry_run` previews ids, and
`has_more` tells operators to repeat the same bounded call. Like single-run
triage, it never deletes a row or changes execution status, errors, or logs.

## Reading the data

- UI: `/@<slug>/-/activity` (open failures first by default; Recent runs lists
  the last 7 days of successes and errors; status / triage / surface filters,
  who started each run, 7-day summary with ignored/resolved counts, log viewer,
  cursor pagination). `/@<slug>/-/jobs` recent runs link into it.
- MCP domain `runs`: `runList`, `runGet`, `runSummary`, `runUpdate`,
  `runUpdateBulk`. `runList` / `runGet` include `started_by` when recorded;
  `runList` can filter by `started_by` person id.
- Account export: section `run_records` pages through the user’s `RunLog`.
- Account deletion: `clearAll` on the user’s `RunLog` stub (deletes every DO
  table — runs, ledger, and dedicated state — then reinitializes schema).

Run records are **excluded from the `storage_bytes` entitlement**. They are
observability history, not user content.

## RunLog authority

The per-user `RunLog` DO is the **sole runtime authority** for:

- workflow lifecycle, idempotency, list/cancel, and concurrent-workflow
  entitlements (`workflow_projections`);
- per-job terminal outcomes and counters (`job_run_observability`);
- package activation counters and milestones (`package_run_successes`,
  `activation_milestones`).

Runtime paths read and write those tables only inside `RunLog`. Workflow
lifecycle code does not use D1 workflow projections. Job finalization and
activation increments do not seed dedicated RunLog rows from D1. D1 `jobs`
retains schedule metadata and retention anchors, but job outcome aggregates come
from `job_run_observability`.

The pre-drop D1 Time Travel bookmark for database
`8c1014d1-6b41-4695-a0a2-159071f0f919` is:
`0000116d-000000d2-000050bd-c7ecd5892a189df7cda145af746bc9c9`. Restore from that
bookmark (or a fresher snapshot taken immediately before apply) if the
destructive migration must be rolled back — do not reintroduce dual-write paths.

## Dedicated RunLog state (outside run-history caps)

The same per-user `RunLog` DO also stores **correctness and observability state
that must survive the ~30-day / 2,000-run history caps** on `runs`. Retention
differs by table; only account deletion `clearAll` removes every dedicated
table.

| Table                   | Role                                                                                                                                                                                                                                          | Retention inside RunLog                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_projections`  | Workflow idempotency + concurrent-workflow entitlements. Includes `binding_name` (typically `DYNAMIC_CALLABLE_WORKFLOWS`) so multiple bindings project correctly. Authoritative for lifecycle; there is no D1 `workflow_runs` table.          | Terminal rows (`complete`, `errored`, `terminated`) age-prune after **90 days** (`workflowProjectionRetentionDays`); active/running rows and short-TTL `creating` reservations are kept. |
| `job_run_observability` | Per-job terminal outcomes and counters for Activity and MCP reads. Not a substitute for D1 schedule metadata; D1 `jobs.last_run_at` / `last_run_status` remain retention anchors only.                                                        | Never pruned by run-history or workflow retention passes.                                                                                                                                |
| `package_run_successes` | Per-package success counters toward activation.                                                                                                                                                                                               | Never pruned.                                                                                                                                                                            |
| `activation_milestones` | One row each for `package_run_succeeded` and `package_activated` (`package_id` on the second). High-frequency HTTP surfaces (`webhook`, `app_fetch`) do not count; activation means two unattended capability successes for the same package. | Never pruned.                                                                                                                                                                            |

Account export pages all of the above through section `run_records` after runs
and ledger rows (`exportRuns` phases: raw run-id cursor, then
`invocation-ledger:`, `workflow-projections:`, `job-run-observability:`,
`package-run-successes:`, `activation-milestones:`). Older run-id and ledger
cursors remain valid.

### Admin insights RunLog reads

The role-gated `/admin/insights` dashboard does **not** fan out per-user RunLog
reads on the request path. The hourly `usage_aggregation` lane writes a
content-free KV snapshot (`admin-insights-runlog:v1`) from bounded
`getAdminInsightsSnapshot` point reads (concurrency capped by
`adminInsightsRunLogConcurrency`). Each snapshot holds aggregate workflow
statuses, job outcome counts, and activation milestone timestamps/ids only —
never workflow or job names, errors, logs, or other user-authored content. The
page reads that snapshot and exposes `runLogCompleteness` (`usersAttempted`,
`usersLoaded`, `complete`, `snapshotUpdatedAt`) so a missing or partial snapshot
degrades run-derived charts with an explicit warning instead of failing the
whole dashboard. D1 supplies only job schedule totals (`totalJobs` and
`enabledJobs`) on that path. Launch funnels (signup through first saved package)
come from indexed `users` stamp columns, not RunLog.

### Admin RunLog SQL billing inspection

`adminRunLogSqlBilling` is a role-gated, content-free operator read of one
user's RunLog SQLite. It returns `getSqlBillingStats` per-op counters,
`PRAGMA index_list` / `table_info` for `run_logs`, `COUNT(*)` for `runs`,
`run_logs`, `package_invocation_ledger`, and `workflow_projections`,
`EXPLAIN QUERY PLAN` for `DELETE`/`SELECT` on `run_logs` by `run_id`, and
`run_count` meta versus `COUNT(*) FROM runs`. It never returns run rows, log
bodies, errors, or other user-authored content. Look up the target by
`stableUserId`, email, or username.

### Admin package placement failures

`adminPackagePlacementFailures` is a role-gated fleet read of failed package
runs in one window (`since` inclusive, `until` exclusive, at most 31 days). It
exists to find owners whose runs broke while the fetch gateway filled secret
placeholders only in request headers. It fans out `summarizePackageFailures` to
the RunLog of every package owner (capped at 1,500, eight at a time) and
returns, per package, the owner id and handle (`orgs.slug`), the package id and
kody id, and two counts with first and last `started_at`:

- `placementRefusals`: failed runs whose `error_message` holds one of the fixed
  header-only refusal texts in `headerOnlyPlacementRefusalMarkers`. Plain-HTTP
  and disallowed-host refusals do not count; those rules still apply.
- `failedRuns`: every failed run of a flagged package, whatever the error. Flag
  packages with `packageIds` or `flaggedByCodemodRun` (a codemod run id and a
  finding label such as `secret outside header`). This covers a placeholder that
  went upstream unfilled, which fails with an upstream error no marker can tell
  apart.

The RunLog classifies messages itself and returns only package ids, counts, and
timestamps. The read never returns run inputs, outputs, logs, error messages, or
secrets, and it sends nothing. `complete` is false when an owner's RunLog read
failed or the owner list hit its cap. Like other RunLog reads, the first RPC to
an owner with no RunLog writes its empty schema.

## Related

- [Usage metering](./usage-metering.md)
- [Data storage](./data-storage.md)
- [Entitlements](./entitlements.md)
- [Inbound webhooks](./webhooks.md)
- End-user: [Activity](../../use/activity.md)
