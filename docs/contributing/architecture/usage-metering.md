# Usage metering

## Contents

- [Per-user isolation](#per-user-isolation)
- [The event schema](#the-event-schema)
- [Sinks](#sinks)
- [Agent package conversation uses](#agent-package-conversation-uses)
- [Helper contract](#helper-contract)
- [Recipe: instrumenting a new chokepoint](#recipe-instrumenting-a-new-chokepoint)
- [Execute interpretable share (`q`)](#execute-interpretable-share-q)
- [MCP search duration](#mcp-search-duration)
- [Onboarding funnel](#onboarding-funnel)
- [Reading the data](#reading-the-data)
- [Usage campaign](#usage-campaign)

Kody records per-user usage events at runtime chokepoints for cost attribution,
admin cohort views, and abuse detection. This document describes the event
schema, the `recordUsage()` helper contract, which chokepoints are instrumented,
and the recipe for instrumenting a new chokepoint.

Deliberately out of scope: quotas, plans, billing, enforcement, and admin
dashboards (see [Entitlements](./entitlements.md) for plan limits). This
document covers event capture and rollups only.

## Per-user isolation

Usage metering follows the repo-wide isolation invariant: every event carries a
required billing scope id on `UsageEvent.userId`, the Analytics Engine index is
that same id, and D1 rollups are keyed by `usage_rollups.user_id`. For Teams,
that id is the **org billing id** (`orgId`). For a personal org the id equals
the owner's stable user id, so AE `index1` / `blob1` and `usage_rollups.user_id`
match the historical per-user key. Types and call sites still often name the
field `userId` even though Analytics Engine `blob1` and `index1` are the org id.

**Actor attribution** is separate: who triggered the metered unit lives in
`actorUserId` / Analytics Engine `blob10` (empty for Automation runs). Org
members share one rollup; account usage breakdowns can split by actor where
`usage_attribution_daily` is populated.

## The event schema

One schema covers every chokepoint. It is defined in
`packages/worker/src/usage/record-usage.ts`:

```ts
type UsageEvent = {
	userId: string // required; org billing id (rollup / AE index1 and blob1)
	eventType: UsageEventType // see the metric table below
	entityId?: string | null // metered entity id when one exists
	durationMs?: number | null // wall-clock duration of the metered unit
	cpuMs?: number | null // CPU time, only when the platform exposes it
	bytes?: number | null // bytes moved/stored when meaningful
	eventCount?: number // coalesced units in one write; defaults to 1
	outcome: 'success' | 'error' | 'caught'
	timestamp?: string // ISO 8601; defaults to time of recording
	surface?: string | null // closed UWD surface; AE blob6
	executeShape?: string | null // execute thin/glue class; AE blob7
	cacheReuse?: 'hit' | 'miss' | null // billing-aligned LOADER reuse; AE blob8
	codeChars?: number | null // module-graph text length; AE double4
	paramsChars?: number | null // stable JSON length of params; AE double5
	packageId?: string | null // saved package id when known; AE blob9 (empty = Ad hoc)
	actorUserId?: string | null // person who triggered the unit; AE blob10 ('' = Automation)
	automationSource?: string | null // closed automation source; AE blob11
	connectionKey?: string | null // credential the unit came through; AE blob12
}
```

When `actorUserId` and `automationSource` are omitted at write time,
`usageEventBlobs()` defaults `blob10` to `userId` (org billing id) for
interactive runs and leaves `blob11` empty. Explicit Automation runs use
`actorUserId: ''` and a non-empty `automationSource` when known. Allowed
`automationSource` values written to Analytics Engine are `''`, `webhook`,
`schedule`, and `email` (platform `event` automations map to `''`). Blob
positions are centralized in `usageEventBlobIndexes` in
`packages/worker/src/usage/record-usage.ts` (0-based array indexes; Analytics
Engine SQL names them `blob1` through `blob12`).

**Connection attribution** (`connectionKey`, AE `blob12`) names the credential a
unit came through, from `usageConnectionKey(request)`:
`<credential kind>:<holder person id>:<credential id>`. Examples:
`mcp-oauth:<person>:<oauth client id>`, `cli:<person>:<cli client id>`,
`api-token:<person>:<token id>`, `schedule::<job id>`. The holder is the acting
person (empty for Automation), so a shared OAuth client id such as the CLI
splits by person. The credential id is last because OAuth client ids are URLs.
OAuth and CLI bearer grants carry their client id on the caller-context wire
(`oauthClientId`), which becomes `request.credential.id` and is inherited by
nested invokes through lineage. `execute`, `dynamic_worker_invoke`, and
`dynamic_worker_day` carry it; `dynamic_worker_day` takes only the connection
key (`usageConnectionFieldsFromRequest`) so its actor blobs, which feed budget
actor weights, keep their meaning. Events recorded before this field existed
have an empty `blob12`.

`eventType` is a closed union defined in the dependency-free
`packages/worker/universal/usage-event-types.ts` (re-exported by
`record-usage.ts`). Add new members there (never ad hoc strings at call sites)
so the set of metrics stays reviewable in one place. The feature-flag registry
declares flag success metrics against this union, and the flag-exposure stream
(`FLAG_EXPOSURES` dataset, see
[feature-flags.md](./feature-flags.md#success-metrics)) is joined with these
events for the admin on/off cohort readout.

### Metrics and their chokepoints

| `eventType`                         | Metered unit                                                                                                                                                                                                                                                                                                                                                                                | Recorded at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `entityId`                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `execute`                           | one MCP execute-tool sandbox evaluation                                                                                                                                                                                                                                                                                                                                                     | `packages/worker/src/mcp/executor.ts` (`execute`), only when the run surface is execute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none                                                                                                                     |
| `package_export`                    | one saved-package bundled-code run                                                                                                                                                                                                                                                                                                                                                          | `packages/worker/src/mcp/run-kody-registry.ts` (bundled runs with a package context)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | package id                                                                                                               |
| `package_static_call`               | one call of a statically imported package export (function-valued, incl. default). Call-time throws buffer as `error`; after the run settles, host finalize rewrites them to `caught` when the run succeeded (caller handled the throw) and keeps `error` when the run failed. Fleet error-rate math counts only `error`. Admin usage rollups expose both `error_count` and `caught_count`. | sandbox-side wrapper stamped by the bundler; validated host-side by `packages/worker/src/usage/package-static-call-usage.ts` (created and finalized only in `run-kody-registry.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | callee package id                                                                                                        |
| `job_run`                           | one job execution                                                                                                                                                                                                                                                                                                                                                                           | `packages/worker/src/jobs/service.ts` (`executeJobOnce`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | job id                                                                                                                   |
| `workflow_run`                      | one Cloudflare Workflow run                                                                                                                                                                                                                                                                                                                                                                 | `packages/worker/src/package-runtime/package-workflows.ts` (`DynamicCallableWorkflow.run`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | workflow instance id                                                                                                     |
| `realtime_session`                  | one realtime websocket session                                                                                                                                                                                                                                                                                                                                                              | reserved — not instrumented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | session id                                                                                                               |
| `outbound_fetch`                    | one outbound fetch through the gateway                                                                                                                                                                                                                                                                                                                                                      | `packages/worker/src/mcp/fetch-gateway.ts` (`KodyFetchGateway.fetch`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | request host                                                                                                             |
| `email_send`                        | one outbound email send attempt                                                                                                                                                                                                                                                                                                                                                             | `packages/worker/src/email/outbound.ts` (`sendOutboundEmail`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | email message id                                                                                                         |
| `email_received`                    | one inbound receive attempt for a routed inbox                                                                                                                                                                                                                                                                                                                                              | `packages/worker/src/email/inbound.ts` (`handleInboundEmail`, after inbox resolution)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | email message id (when stored)                                                                                           |
| `dynamic_worker_day`                | first use of one Dynamic Worker id on a UTC day                                                                                                                                                                                                                                                                                                                                             | `packages/worker/src/mcp/executor.ts` after `createStableDynamicWorkerId` (sandbox surfaces) and `packages/worker/src/package-runtime/package-app.ts` (`APP_LOADER` with a stable id); uniqueness via `UserMeter.claimDynamicWorkerDay`. Each event carries `surface` (Analytics Engine blob6) and optional `packageId` (blob9) when the run belongs to a known package.                                                                                                                                                                                                                                                                                                                     | worker id                                                                                                                |
| `dynamic_worker_invoke`             | one LOADER evaluate (hit or miss) on the execute-sandbox path                                                                                                                                                                                                                                                                                                                               | `packages/worker/src/mcp/executor.ts` after `claimDynamicWorkerDay`, on every signed-in sandbox surface (execute, job, package_export, workflow, …). Observe-only. `cacheReuse` is `miss` when `claimDynamicWorkerDay.created === true` and `hit` otherwise. Also carries `codeChars`, `paramsChars`, `durationMs`, `surface`, and `executeShape` when known. No worker id, source, params, or package names.                                                                                                                                                                                                                                                                                | none                                                                                                                     |
| `dynamic_worker_cpu`                | one Worker Loader invocation's CPU as measured by Cloudflare (`TraceItem.cpuTime` → `cpuMs`, AE double2; `wallTime` → `durationMs`). Zero is recorded, so `event_count` is tail delivery coverage against `dynamic_worker_invoke`.                                                                                                                                                          | `DynamicWorkerUsageTail` (`packages/worker/src/usage/dynamic-worker-cpu.ts`), attached as `WorkerCode.tails` by `createExecuteExecutor` on every executor surface when the loopback export exists (origin, platform, runtime). Runs after the response. Tailed isolates use a separate Loader cache id (`-cpu1` suffix) so cached tail-less isolates cannot skip it; `entityId` stays the stable worker id. `outcome` is the isolate's platform outcome, not the sandbox result. Package-app `APP_LOADER` isolates do not attach it. Observe-only; included in admin usage rollups, the shared admin `usageMetricSeries` (insights and per-user usage charts), and insights duration labels. | worker id                                                                                                                |
| `durable_object_gb_seconds`         | one typed per-user Durable Object RPC burst (wall-clock in `durationMs`; admin converts to GB-s at 128 MB). Same-outcome RPCs in one request coalesce into a single Analytics Engine point whose `eventCount` is the RPC count.                                                                                                                                                             | `createMeteredDurableObjectStub` on `storageRunnerRpc` when `USAGE_EVENTS` is bound. Other per-user RPC factories can adopt the same helper; UserMeter, Mailbox, RunLog, and RepoSessionIndex stay unwrapped so admin usage reads do not inflate the metric. Observe-only / unmetered: excluded from fleet event-count rankings, entitlement-pressure candidate selection, and customer usage emails. Never billed.                                                                                                                                                                                                                                                                          | DO class name                                                                                                            |
| `durable_object_rows_read`          | Customer-controlled StorageRunner SQLite rows read: cursor `rowsRead` from `sqlQuery`, plus key-value reads at Cloudflare's billing unit (1 per `getValue` key, 1 per `listValues` entry including the truncation look-ahead). Zero-row reads are skipped.                                                                                                                                  | `storageRunnerRpc` (`recordDurableObjectRowsRead`). Queued into the same per-burst coalescer as duration, so one run writes one point per (user, class, outcome, packageId). When the storage id is package-owned, `packageId` is stamped (blob9); otherwise the debit stays Ad hoc. Observe-only for fleet event-count rankings and entitlement-pressure selection; credit debits and compute-include warning emails read the rollup.                                                                                                                                                                                                                                                       | DO class name                                                                                                            |
| `durable_object_platform_rows_read` | Rows read by Kody-owned per-user Durable Objects. RunLog only: every tracked `execSqlTracked` cursor's `rowsRead`, attributed to the DO name (the stable user id via `ctx.id.name`).                                                                                                                                                                                                        | `RunLog.recordSqlBilling` (`recordDurableObjectPlatformRowsRead`), coalesced like the customer meter. Recorded only when `USAGE_EVENTS` is bound (no per-statement local D1 fallback). Observe-only cost visibility on admin usage; never in include, credit debit, or warning math.                                                                                                                                                                                                                                                                                                                                                                                                         | DO class name                                                                                                            |
| `api_call`                          | one Open API operation (`api.kody.codes`, the MCP `api` tool, a CapabilityProxy hop, or local-execute package-graph prep)                                                                                                                                                                                                                                                                   | `packages/worker/src/open-api/invoke.ts` (`invokeApiOperation`), including CapabilityProxy / package-graph scope failures that run through invoke, and CapabilityProxy auth failures metered from `http-handler` when the token resolves to a user. Observe-only. Local-execute native failure entity ids append `:<ApiErrorCode>` (e.g. `capabilityProxySession:insufficient_scope`, `localExecutePackageGraph:package_import_unresolved`). The capability behind the operation meters itself as usual; local-execute CPU is never recorded. Package-graph prep is not `execute` / `dynamic_worker_day`.                                                                                    | operation id, or `capability-proxy:<path>` for proxy hops; CapabilityProxy / package-graph failures may append `:<code>` |

`email_received` covers receive attempts once an inbound message is routed to a
known, enabled inbox: stored messages record `success`; unverified-account
rejections, size rejections, entitlement rejections, and parse failures record
`error`. The `bytes` field always carries the raw message size, including for
rejected mail. Mail rejected before inbox resolution (unknown alias, disabled
inbox) has no owning user and is not metered.

`createMeteredDurableObjectStub` must not wrap the RpcStub as the Proxy target.
Cloudflare RPC binds stub methods to the receiver; a Proxy-of-stub is not a
valid RPC receiver, so every StorageRunner call throws "Proxy could not be
serialized because it is not a valid RPC receiver type". That includes
`packageStorage()` get of a missing key on export, subscription, job, and
execute — `storageRunnerRpc` is the only production call site, so one broken
wrapper fails every surface that touches package storage. The wrapper is a
plain-object Proxy that `Reflect.get` / `Reflect.apply`s against the original
stub. Local and workers-unit `env` omit `USAGE_EVENTS`, which skips the wrapper;
tests that need the production path bind a stub Analytics Engine dataset.

### Durable Object rows-read policy

Cloudflare bills SQLite-backed Durable Objects for rows read, including
key-value `get()` / `list()` calls on their hidden table. Kody splits that cost
by who controls the query shape:

- **Customer (`durable_object_rows_read`)** — StorageRunner, the per-bucket
  store behind `storage.*` and `packageStorage()`. SQL uses the cursor's real
  `rowsRead`; the KV API exposes no cursor, so reads use Cloudflare's documented
  per-key / per-entry billing unit. `exportStorage` is platform-initiated
  (account export, backup) and stays unmetered. This is the include / credit
  debit meter.
- **Platform (`durable_object_platform_rows_read`)** — RunLog run history. Its
  reads come from Kody's own queries (one RunLog hot spot read ~14B rows/day on
  one account), so they are recorded for cost visibility but never counted
  against a customer's include or invoiced.
- **Not instrumented** — Mailbox (inbound volume is sender-controlled and small:
  ~7M rows in September 2026), UserMeter (enforcement bookkeeping, ~10M),
  RepoSessionIndex, RepoSession, McpClientHub, and MCP session DOs. Their cost
  shows only in Cloudflare account analytics. Instrument one by recording its
  cursor `rowsRead` through `recordDurableObjectPlatformRowsRead`.

Per-call rows-read points share the ~250 `writeDataPoint` per-invocation budget
with every other usage event, so they always go through the coalescer
(`queueDurableObjectRowsRead`) rather than writing one point per query.

### Oversized storage reads

A single StorageRunner SQL statement is allowed when it examines more rows than
a typical query. That matches compute-wallet overage: meter the rows, warn, and
do not invoice. Kody absorbs the infrastructure cost under the ceiling below.
The monthly include, credit debit, and empty-wallet stop are unchanged (see
[Prepaid credits](./entitlements.md#prepaid-credits)).

The returned row list stays capped at `maxStorageSqlQueryRows` (1,000) with
`truncated: true`. That cap limits the response. Scan cost is the cursor's
`rowsRead`.

| Constant                    | Value         | Effect                                                                                                                                                                                |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageSqlRowsReadWarnAt`  | 1,000,000     | The call succeeds. `warning` says the read was allowed and counts toward the monthly Rows read include (credits past the include).                                                    |
| `storageSqlRowsReadCeiling` | 1,000,000,000 | A read cursor stops. The call fails with `storage.sql read stopped…`. Rows already examined are still metered (`outcome: error`, so they stay in `event_count` and the credit debit). |

Mutating statements (`INSERT` / `UPDATE` / `DELETE` / `REPLACE`, including after
`WITH`) keep stepping so a write is not cut off. Other writes, including
`CREATE TABLE AS SELECT`, also succeed when the scan passes the ceiling:
`warning` says the write finished and the rows are metered, because the bucket
change is already committed. Verb checks ignore words inside strings,
identifiers, and comments. After `WITH`, only `INSERT` / `UPDATE` / `DELETE` /
`REPLACE` count as writes, so a `WITH … SELECT` that quotes `insert` or names a
CTE `create` stays a read and still stops at the ceiling.

Both constants live in `packages/worker/src/storage-sql-read-policy.ts`. They
are a gut feel, not a price: 1,000,000 rows is one unit at the published
$0.002 per million rate, and 1,000,000,000 rows is $2 at that rate (about $1 at
Cloudflare list). Move them when fleet data says the line is wrong. Some plans
(`ORDER BY`, aggregates) finish the scan inside SQLite before the first row is
yielded, so Cloudflare may already have counted those rows before the ceiling
check runs. Stopping still refuses the result and meters what the cursor
reports.

### Durable Object duration: estimate vs bill

Cloudflare bills Durable Object duration on wall-clock time an object is active
and not hibernation-eligible, at 128 MB, against an account-wide include
(400,000 GB-s/month, then $12.50 per million GB-s). Kody has two per-user views
of it. Neither is an invoice line.

- **Cloudflare-measured (trustworthy, per object):** the hourly
  `durable_object_duration_attribution` lane (minute 20;
  `packages/worker/src/usage/durable-object-duration-attribution.ts`) reads
  Cloudflare GraphQL `durableObjectsPeriodicGroups.sum.activeTime` per
  `objectId` for yesterday and today (UTC). It rebuilds `idFromName` for every
  frozen per-user name (McpClientHub, RunLog, UserMeter, Mailbox,
  RepoSessionIndex, StripePlanRefresh by stable user id; StorageRunner and
  RepoSession from `user_storage_buckets`; PackageRealtimeSession from
  app-bearing `saved_packages`) and writes absolute daily rows to
  `durable_object_duration_daily`. It writes fleet totals and the attributed
  share to `durable_object_duration_coverage_daily`. Admin usage shows GB-s
  (active seconds × 0.128) and gross dollars at list.
- **Not attributed:** MCP session DOs (named by transport session), JobManager
  (lives on `kody-jobs`, no origin binding), repo sessions discarded before the
  lane runs, platform singletons, and objects beyond the top 10,000 by active
  time on a day (`truncated = 1` on the coverage row). These stay in the day's
  unattributed total; nothing is guessed. The day's total comes from
  Cloudflare's account-wide aggregate (a second, dimension-less group in the
  same query), so truncation never shrinks the denominator. A response with no
  matching account fails the lane rather than zeroing the day, a day with no
  objects yet (analytics lag) keeps its last write, and owners whose deletion or
  soft-delete started after the owner snapshot get no rows. A live team org id
  (no `users` row) is kept. The live-owner predicate is `liveBillingOwnerSql`,
  shared with `usage_rollups`.
- **Why it is an estimate:** the include and Cloudflare's rounding apply to the
  account total, isolate sharing does not change per-object billing, and
  analytics for the current day are partial until the next day's run.
- **RPC proxy (`durable_object_gb_seconds`):** caller-side StorageRunner RPC
  wall clock × 0.128. It misses time an object stays active without an RPC
  (sockets, alarms) and every other class. Keep it for burst shape only; use the
  Cloudflare-measured view for cost.

The lane uses the origin `CLOUDFLARE_API_TOKEN` (Account Analytics read, same as
the Analytics Engine SQL API) and fails the lane loudly if Cloudflare rejects
the query.

### `package_static_call`: statically imported package export calls

Static imports (`import fn from 'kody:@scope/pkg/export'`) are the default way
package code is reused, so calls through them are metered per call:

- **Metered unit:** one call of a function-valued export (named or default) that
  was statically imported from a saved package. Non-function exports pass
  through unwrapped; imports that are never called record nothing. `userId` is
  the user the host run executes as, `entityId` is the **callee** package id,
  `durationMs` is the wall time of the call (through settlement for async
  functions), and `outcome` is `error` iff the call threw or rejected — the
  error still propagates to the caller unchanged.
- **Provenance is bundler stamping, never sandbox strings.** The import
  rewriter's proxy module (`ensurePackageProxy` in
  `packages/worker/src/package-runtime/module-graph-import-rewriting.ts`) knows
  which saved package a `kody:@…` specifier resolved to and bakes that id into
  the generated proxy (`createMeteredPackageImportProxySource`), which wraps
  function exports with `__kodyMeterStaticPackageExport` from the virtual
  runtime module — the same stamping discipline as per-package
  `packageStorage()` routing. Root self-imports are not stamped (the run already
  records `package_export` for that package).
- **Host-side validation (trust model, stated honestly):** stamped ids ride in
  generated code, but that code still executes inside the sandbox realm, so a
  malicious module could forge reports. The host
  (`createPackageStaticCallMeterTools` in
  `packages/worker/src/usage/package-static-call-usage.ts`) only records events
  whose stamped id is in the bundle's **static** dependency package ids recorded
  at build time (`bundle.dependencies`) — a strict subset of the
  `packageStorage()` grant set, which additionally grants the run's own package
  id and dynamic-import dependencies, neither of which the bundler ever stamps
  into a metered proxy — and silently drops the rest with a debug log. Forgery
  can therefore at worst inflate counts for packages the bundle already
  statically depends on.
- **Delivery never blocks the call path.** Each call does one synchronous buffer
  push (capped at 200 events per run — Analytics Engine allows 250
  `writeDataPoint` calls per invocation, one per event, and the run's other
  usage events need headroom; overflow is dropped and the cap is enforced
  host-side too); the run wrapper in `runBundledModuleWithRegistry` flushes the
  buffer over a runtime bridge in batches at the end of the run, while the
  sandbox RPC dispatchers are still live — a fire-and-forget RPC per call would
  race dispatcher teardown and lose events. The awaited flush is bounded by a
  short timeout so a slow bridge never owns the run's tail latency, and it loops
  (bounded) so async calls that settle during an in-flight flush are still
  delivered; calls that have **not settled when the run's entrypoint finishes**
  (a promise the run never awaited) are not metered — metering never extends a
  run's lifetime, and such a dangling promise may never settle inside the
  sandbox at all. Flush failures are swallowed.
- **Coverage:** every surface that funnels through
  `runBundledModuleWithRegistry` (ad hoc execute with static `kody:@…` imports,
  saved-package invocations, and the job/workflow/service runs built on them).
  Package-app fetch handlers use a separate runtime bridge and do not bind the
  meter; the wrapper no-ops there.
- **Capacity note:** the 200-events-per-run cap shares the ~250
  `writeDataPoint`-per-invocation Analytics Engine budget with every other usage
  event in the same invocation — in particular `outbound_fetch`, which also
  scales per operation. A heavy run (many static calls **and** many gateway
  fetches) can exceed the budget and Analytics Engine silently drops the
  overflow points. The eventual fix is aggregation (coalescing per-callee
  counts/durations into fewer data points), not raising the cap.

### Nesting: metrics are independent, do not sum across types

Execution surfaces nest. A package job funnels through the bundled-module runner
and the sandbox executor, so it produces one `job_run` and one `package_export`.
It does **not** also emit `execute` — that metric is MCP `execute` tool work
only, matching `execute_unique_workers_per_day` and `first_execute_at`. A
bundled execute-tool run that calls statically imported package exports still
produces one `package_static_call` per call **inside** that run's `execute`
span. Each metric answers its own question (`execute` is ad-hoc execute-tool
volume; `job_run` is job activity; `package_export` is saved-package
entrypoints; `package_static_call` is per-callee reuse). `dynamic_worker_day` is
the Cloudflare bill unit: one unique Dynamic Worker id per user per UTC day, on
every sandbox surface that creates a worker. `dynamic_worker_invoke` is the
observe-only reuse meter: one event per execute-sandbox LOADER evaluate,
including later claims of the same id on the same UTC day. Do not add it to
entitlements or fleet event-count rankings.
`PlanLimits.maxUniqueWorkerDaysPerMonth` is the public included allotment shown
on `/pricing`. It is not in `entitlementResources` and does not replace the hard
daily `execute` / `job_run` caps, or the public-ladder weekly execute and
outbound-fetch windows. `usageGet` and the account usage UI report this meter
(and Durable Object rows-read) with `whatCounts` / `howToReduce` so the include
is self-explanatory. When unique-worker-day pressure is hot (limit denial or
over 80%), those payloads also include a short `mechanic` line: meter name plus
what a unique worker day is. Agent-facing package docs do not repeat the cost
model; see [Platform efficiency](../../guides/platform-efficiency.md).

### Unique worker days by surface

Every `dynamic_worker_day` event carries a closed `surface` tag (Analytics
Engine blob6): `execute`, `job`, `package_export`, `workflow`, `subscription`,
`app_fetch`, `app_realtime`, `retriever`, `webhook`, or `unknown`.
`package_export` is the usage name for run-record surface `export`. Call sites
pass the mapped surface; `unknown` is only for a missing mapping. When the
registry does not own the run record (keyed package invocations, inline
workflows), callers pass `runSurface` so UWD is not inferred as
`package_export`.

D1 `usage_rollups` stay keyed by `(user_id, metric, month)` for the monthly
total. Surface share is an Analytics Engine query. Hourly aggregation does not
write a second rollup dimension. Use `buildUniqueWorkerDayBySurfaceQuery` in
`packages/worker/src/usage/aggregate-rollups.ts`:

```sql
SELECT
  if(blob6 = '', 'unknown', blob6) AS surface,
  sum(_sample_interval) AS unique_worker_days
FROM kody_usage_events
WHERE timestamp >= toDateTime('2026-09-01 00:00:00')
  AND timestamp < toDateTime('2026-10-01 00:00:00')
  AND blob2 = 'dynamic_worker_day'
GROUP BY surface
ORDER BY unique_worker_days DESC
```

Empty `blob6` means the event has no surface tag. Preview uses
`kody_usage_events_preview`. Execute share for the month is
`sumIf(_sample_interval, blob6 = 'execute') / sum(_sample_interval)` on that
same filter.

Ad hoc execute events may also carry `executeShape` on blob7
(`thin_single_export` | `thin_few_exports` | `glue`): a host-side best-effort
class of the caller-authored source string. It is not used for billing and is
not shown to agents. Unparseable source omits the field.

### Dynamic Worker reuse (hit vs miss)

Every execute-sandbox LOADER evaluate records `dynamic_worker_invoke` after
`claimDynamicWorkerDay`, including when the claim returns `created: false`.
`cacheReuse` is billing-aligned: `miss` on the first `(user, workerId, UTC day)`
claim, `hit` on later claims of that id the same day. The event also carries
`durationMs` (sandbox evaluate wall-clock), `codeChars` (total character length
of the module-graph text hashed into the id), `surface`, `executeShape` when the
run classified one, and `paramsChars` (character length of a key-sorted JSON
serialization of `params`; **0** when `params` is omitted, `null`, a non-object,
an array, or empty `{}` — not 2 from stringifying `{}`). Payloads never include
source, param keys or values, package names, or worker ids.

D1 `usage_rollups` for `dynamic_worker_invoke` is the monthly invoke count (and
summed duration). Hit rate and average `paramsChars` are Analytics Engine
queries. Use `buildDynamicWorkerInvokeReuseQuery` and
`buildDynamicWorkerReuseRatioQuery` in
`packages/worker/src/usage/aggregate-rollups.ts`:

```sql
SELECT
  if(blob8 = '', 'unknown', blob8) AS cache_reuse,
  if(blob6 = '', 'unknown', blob6) AS surface,
  sum(_sample_interval) AS invokes,
  sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_duration_ms,
  sum(double4 * _sample_interval) / sum(_sample_interval) AS avg_code_chars,
  sum(double5 * _sample_interval) / sum(_sample_interval) AS avg_params_chars
FROM kody_usage_events
WHERE timestamp >= toDateTime('2026-09-01 00:00:00')
  AND timestamp < toDateTime('2026-10-01 00:00:00')
  AND blob2 = 'dynamic_worker_invoke'
GROUP BY cache_reuse, surface
ORDER BY invokes DESC
```

Fleet hit rate is
`sumIf(_sample_interval, blob8 = 'hit') / sum(_sample_interval)` on
`blob2 = 'dynamic_worker_invoke'`. Unique-day yield is
`dynamic_worker_day / dynamic_worker_invoke` (or `/ execute` for execute-tool
volume). Same-user same-graph executes that vary only `params` reuse one worker
id; execute-surface hit rate and unique-day yield are the fleet readouts for
that reuse.

APP_LOADER package-app isolates record UWD (`dynamic_worker_day`) when the
worker id is stable (`app_fetch` / `app_realtime`). They do not emit
`dynamic_worker_invoke`. One-off `APP_LOADER.load()` without a hashed id has no
worker id to claim and does not emit `dynamic_worker_day`.

### LOADER worker identity

`createStableDynamicWorkerId` in `packages/worker/src/mcp/dynamic-worker-id.ts`
mints the execute-sandbox worker id. The hash is the sandbox-contract version
(`dynamicWorkerCacheKeyVersion`, bumped only when the executor or identity
contract changes), the `LOADER` binding name, the acting `userId` and
`storageContext`, compatibility date/flags, the main module name, and the module
graph (agent code plus the generated executor harness).

Timeout, `allowOutboundFetch`, and the excluded fetch hostname are baked into
that harness text, so they are not hashed again. Execute `params`,
`packageContext`, live MCP connect/tool metadata, and the unstamped
`packageSecrets` binding (present only when that evaluate's package id is set)
arrive on `evaluate` RPC and are not part of the key: the same user and module
graph reuse one isolate when only those per-call values change. Deploy SHA
(`APP_COMMIT_SHA`), email, and other request-only `gatewayProps` fields are also
omitted, so a parent deploy remints ids only when the harness or module graph
actually changes.

`userId` and `storageContext` stay in the key because `LOADER.get` reuses the
first factory's WorkerCode for a given id, including the `KodyFetchGateway`
`globalOutbound` stub. Those props authorize outbound fetch, secrets, and quota,
so two users (or two storage contexts) with the same module graph still get
distinct ids. UWD metering stays `(userId, workerId, day)` via
`claimDynamicWorkerDay` and is independent of this hash.

Every module value is hashed deterministically: strings, `ArrayBuffer` and
typed-array bytes (including fields such as `wasm`), and JSON values. A function
or symbol inside a module throws instead of minting a one-off id, because a
one-off id would bill and count as a new worker on every call. Ids stay stable
when `userId` is null or `APP_COMMIT_SHA` is unset.

Tailed isolates load under `${workerId}-cpu1` (see `dynamic_worker_cpu`). Every
deployed script that runs metered sandboxes (origin, platform, runtime) binds
`USAGE_EVENTS` and exports `DynamicWorkerUsageTail`, so a counted id always
loads under that one suffixed LOADER id: Cloudflare sees one worker per metered
id per day. Untailed loads happen only without a user (no metering) or without
the binding (local and tests).

The customer-facing monthly meters are unique worker days plus Durable Object
rows-read. Usage above the include debits a funded purchasable-Pro credit wallet
(`creditDebitRates`: $0.004 per unique worker day, $0.002 per million rows read)
in the hourly `usage_aggregation` lane, right after the rollup recompute. On an
empty purchasable-Pro wallet, the same rollups stop new execute, job, and
automation runs once either include is used up. Nobody is invoiced for overage.
See [Entitlements](./entitlements.md#prepaid-credits). Never add durations
across different `eventType` values — that double counts nested layers. Within
one `eventType`, each chokepoint records exactly one event per metered unit, so
sums are safe.

Admin usage and insights convert `dynamic_worker_day` counts to a **gross**
Cloudflare estimate (`unique days × $0.002`). The 1,000 included unique
worker-days per month are account-wide, so per-user dollars are not a net bill
share. Worker ids stay inside UserMeter and Analytics Engine `entityId`; account
export does not list them.

## Sinks

`recordUsage()` picks its sink by environment:

1. **Workers Analytics Engine is the write path in production and preview**
   (`USAGE_EVENTS` dataset binding, configured for the `production` and
   `preview` environments in `packages/worker/wrangler.jsonc`). When the binding
   is present, each event is one non-blocking `writeDataPoint` call and nothing
   else — a per-event D1 upsert would serialize every metered request (execute,
   fetch, email, jobs, ...) on D1's single writer. Data point layout (see
   `usageEventBlobIndexes` in `packages/worker/src/usage/record-usage.ts`):
   - `indexes`: `[userId]` where `userId` is the org billing id
   - `blobs` (Analytics Engine `blob1` through `blob12`):
     - blob1: org billing id (same as `UsageEvent.userId`)
     - blob2: `eventType`
     - blob3: `entityId ?? ''`
     - blob4: `outcome`
     - blob5: event `timestamp` (ISO 8601)
     - blob6: `surface ?? ''`
     - blob7: `executeShape ?? ''`
     - blob8: `cacheReuse ?? ''`
     - blob9: `packageId ?? ''` (empty means Ad hoc for customer credit
       attribution on `/account/usage`)
     - blob10: `actorUserId` (`''` for Automation; otherwise defaults to org
       billing id when unset on the event)
     - blob11: `automationSource` (`''` | `webhook` | `schedule` | `email`)
     - blob12: `connectionKey ?? ''` (see Connection attribution)
   - `doubles`:
     `[durationMs ?? 0, cpuMs ?? 0, bytes ?? 0, codeChars ?? 0, paramsChars ?? 0]`.
     Coalesced points (`coalescedCountUsageEventTypes`:
     `durable_object_gb_seconds`, `durable_object_rows_read`,
     `durable_object_platform_rows_read`) store the coalesced unit count in the
     third double instead of bytes so hourly rollups can recover `event_count`.
     `codeChars` is double4 (module-graph text length on
     `dynamic_worker_invoke`). `paramsChars` is double5 (key-sorted JSON length
     of evaluate `params`; **0** when `params` is omitted, `null`, a non-object,
     an array, or empty `{}`).

   Analytics Engine is the analysis store (sampling-tolerant, high cardinality).
   Do not build enforcement on it.

2. **D1 `usage_rollups` is a derived aggregate** (defined in
   `packages/worker/migrations/0001-squashed-init.sql`): per-user, per-metric,
   per-month counters:
   - key: `(user_id, metric, month)` where `metric` is the `eventType` and
     `month` is the UTC `YYYY-MM` prefix of the event timestamp
   - counters: `event_count`, `error_count`, `total_duration_ms`,
     `total_cpu_ms`, `total_bytes`

   In production/preview the rows are recomputed hourly by
   `aggregateUsageRollups` in `packages/worker/src/usage/aggregate-rollups.ts`
   (gated by `shouldRunUsageAggregationCron` in the scheduled handler).
   `kody-jobs` fires cron and forwards to origin `JobsHost`, which runs this
   lane: it queries the Analytics Engine SQL API for the current UTC month
   grouped by billing id and metric (weighting by `_sample_interval`, since
   Analytics Engine samples under load) and batch-upserts absolute values — an
   idempotent recompute, not increments. The live-owner guard keeps a row when
   the id is a live user or a live org, so a team org wallet still has a rollup
   to debit. Soft-deleted owners are left out and their current-month rows are
   removed. Analytics Engine retention (~90 days) always covers a full month, so
   month-to-date recompute is complete; prior months already in D1 stay
   untouched. Analytics Engine rejects the whole query (HTTP 422) when an `if()`
   mixes a `doubleN` branch with an Integer literal, so fallbacks in that query
   are Float literals (`1.0`, `0.0`); `aggregate-rollups.node.test.ts` guards
   this. The aggregation needs `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_API_TOKEN` and no-ops with a debug log when either (or the
   `USAGE_EVENTS` binding) is missing.

   **Local-dev direct fallback:** when `USAGE_EVENTS` is absent (local dev,
   tests), `recordUsage` upserts `usage_rollups` directly per event, so local
   admin pages and workers-unit tests work without Analytics Engine access.

   The rollup is the cheap read path for month-to-date admin and cohort views:
   one point lookup per user, metric, and month.

3. **D1 `usage_attribution_daily`** (billable-unit breakdown for
   `/account/usage`) stores daily units per org billing id, package, and meter.
   Columns `actor_user_id` and `automation_source` mirror Analytics Engine
   `blob10` and `blob11`. Local dev upserts them on each billable `recordUsage`
   write; production recomputes from Analytics Engine in
   `packages/worker/src/usage/credit-attribution.ts`. Writers should populate
   attribution on the event (or rely on the `usageEventBlobs()` defaults) so
   these columns are not left null when actor or automation context exists.

4. **D1 `usage_connection_daily`** (per-connection usage for the Agents page)
   stores daily units per org billing id, connection (`credential_kind`,
   `holder_user_id`, `credential_id` split from `blob12`), package (`blob9`),
   and event type (`execute`, `dynamic_worker_day`, `dynamic_worker_invoke`).
   The hourly `usage_aggregation` lane runs `aggregateConnectionUsageDaily`
   (`packages/worker/src/usage/connection-usage-rollup.ts`): it rewrites
   yesterday and today with absolute `_sample_interval` sums, writes only rows
   that changed, deletes yesterday's rows Analytics Engine no longer reports
   (only when it returned rows for yesterday; today's rows are never deleted
   because ingestion lags), and prunes days older than 14. Local dev upserts on
   each `recordUsage` write. Rows with an empty `credential_kind` predate
   connection tracking. `/account/connection-usage.json` (`loadConnectionUsage`
   in `connection-usage.ts`) reads it for the page org: everyone sees their own
   connections; `billing:read` adds Automation, other people by username only,
   and untracked units. The org comes from the Referer on `/@slug/-/agents`,
   like `/account/connected-agents.json`. Package names follow the team
   Repositories rule (`canSeeResource`): a package the viewer cannot see keeps
   its units under a generic label, and team packages do not link until they
   have detail pages.

## Agent package conversation uses

Separate from `usage_rollups`, D1 table `agent_package_conversation_uses` (also
defined in `0001-squashed-init.sql`) tracks **distinct conversations** in which
a signed-in user’s agents used a saved package via MCP `execute` (package-export
runs attributed to that execute call, plus static/dynamic `kody:@…` deps
attributed to that execute call’s `conversationId`).

- Key: `(user_id, package_id, conversation_id)` — upsert updates `last_used_at`;
  the same package in the same conversation counts once. Stored
  `conversation_id` values are SHA-256 hex digests of the MCP conversation id
  (cardinality only; not reversible to the raw id).
- MCP server instructions do **not** inject popularity rankings from this table.
- Writes are best-effort and never throw into the invoke path (same spirit as
  `recordUsage`). Do **not** widen `usage_rollups` for conversation cardinality.

Helpers live in `packages/worker/src/usage/agent-package-conversation-uses.ts`.

## Helper contract

```ts
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
} from '#worker/usage/record-usage.ts'

await recordUsage(env, {
	userId: orgBillingId,
	...usageAttributionFieldsFromRequest(requestContext),
	eventType: 'job_run',
	entityId: job.id,
	durationMs,
	outcome: execution.ok ? 'success' : 'error',
})
```

`usageAttributionFieldsFromRequest` maps a `RequestContext` to `actorUserId` /
`automationSource` when the chokepoint has one: interactive requests stamp the
signed-in actor; Automation requests use `actorUserId: ''` and the closed
automation source when present.

Guarantees and rules:

- `recordUsage` **never throws and never rejects.** Metering must not break the
  path it observes. Sink failures are logged at warn level; expected local-dev
  degradation is logged at debug level.
- Every recorded event also emits a `kody.usage.{eventType}` **trace span**
  (when Workers tracing is available) with `kody.user_id`, `kody.event_type`,
  `kody.outcome`, and the optional `kody.entity_id` / `kody.duration_ms` /
  `kody.bytes` attributes. It nests under the active platform span, so traces
  become searchable by user and feature with no chokepoint changes. Span
  emission follows the same never-throws contract.
- It accepts any object with optional `USAGE_EVENTS` / `APP_DB` bindings
  (`UsageEnv`), so the full `Env` can be passed directly.
- **Graceful degradation:** in local dev and tests where the Analytics Engine
  binding is not present, the event is logged via `console.debug` and upserted
  into `usage_rollups` directly; when `APP_DB` is missing (or the table does not
  exist), the rollup write is skipped with a debug log.
- If `userId` is empty, the event is skipped entirely. Callers on paths that can
  run without a user (for example anonymous gateway fetches) must guard with
  `if (userId)` and not invent placeholder ids.
- The returned promise resolves quickly (one `writeDataPoint`, or one D1 upsert
  in local dev). `await` it inline, or pass it to `ctx.waitUntil(...)` inside
  Durable Objects when the caller must not block.

## Recipe: instrumenting a new chokepoint

1. **Pick the metered unit.** One event per semantic unit (one run, one fetch,
   one send). If your chokepoint already funnels through an instrumented layer,
   that is fine — you are adding a new metric, not replacing one — but never
   record the same `eventType` twice for one unit.
2. **Add the `eventType`** to the `UsageEventType` union in
   `packages/worker/src/usage/record-usage.ts` if it does not exist, and add a
   row to the metric table in this document.
3. **Find the narrowest span** where you have all of: the `userId`, the entity
   id, the start time, and the outcome. Wrap it:

   ```ts
   const startedAtMs = Date.now()
   let outcome: 'success' | 'error' = 'success'
   try {
   	// existing work
   } catch (error) {
   	outcome = 'error'
   	throw error
   } finally {
   	if (userId) {
   		await recordUsage(env, {
   			userId,
   			eventType: 'my_metric',
   			entityId,
   			durationMs: Date.now() - startedAtMs,
   			outcome,
   		})
   	}
   }
   ```

   A result object that carries an `error` field (like `ExecuteResult`) counts
   as `outcome: 'error'` even when nothing throws.

4. **Populate optional fields when cheap.** `bytes` for transfer-shaped metrics,
   `cpuMs` only when the platform exposes it. Leave fields you cannot measure as
   `undefined` — do not approximate, and never use wall clock as CPU. Worker
   Loader CPU arrives through the `dynamic_worker_cpu` tail; other chokepoints
   (host-side execute, jobs, fetch gateway) have no per-call CPU API and leave
   `cpuMs` unset. Open-source workerd reports `cpuTime` 0, so real values only
   appear on deployed Workers.
5. **Do not change behavior.** No new throws, no altered return values, no added
   latency beyond the awaited write (use `ctx.waitUntil` in DOs if needed).
6. **Test it.** Pick the flavor with the
   [test flavor decision matrix](../testing-principles.md#test-flavor-decision-matrix).
   In `*.node.test.ts`, spy on the helper:

   ```ts
   const usageModule = await import('#worker/usage/record-usage.ts')
   const recordUsageSpy = vi
   	.spyOn(usageModule, 'recordUsage')
   	.mockResolvedValue(undefined)
   ```

   Assert one call per metered unit with the expected `userId`, `eventType`,
   `entityId`, and `outcome` for both a success and a failure path, then
   `recordUsageSpy.mockRestore()`. The exemplar is the usage test in
   `packages/worker/src/mcp/executor.node.test.ts`. For `*.workers.test.ts`
   suites with a real local D1, create the table with
   `ensureUsageRollupsTestSchema` from
   `packages/worker/src/usage/test-schema.ts` and assert on `usage_rollups` rows
   instead.

## Execute interpretable share (`q`)

Measurement-only Analytics Engine dataset for the share of MCP execute modules
that are interpretable pure glue (suitable for a hypothetical fixed-interpreter
tier). This is **not** a `recordUsage()` event and does not enter
`usage_rollups`. The classifier and write path live in
`packages/worker/src/mcp/execute-interpretable.ts`.

A module is the `q` numerator when it is pure orchestration over `kody.*` /
`kody:runtime` and has none of: `kody:@` package imports, bare npm imports,
`node:` builtins, ambient `fetch` / `createAuthenticatedFetch` /
`oauthClientCredentials`, computed `import(expr)`, or any other
non-`kody:runtime` specifier. Type-only imports are ignored. Unparseable source
is conservative (not interpretable). This is not an interpreter runtime.

Production dataset `kody_execute_interpretable_events` (preview:
`kody_execute_interpretable_events_preview`). Binding
`EXECUTE_INTERPRETABLE_EVENTS` on origin and platform (where MCP execute runs).
Schema:

| Field     | Value                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index1`  | `execute_interpretable_q` (shared sampling population)                                                                                                         |
| `blob1`   | `interpretable` or `non_interpretable`                                                                                                                         |
| `blob2`   | `glue`, or first disqualifier: `has_package_import`, `has_npm`, `has_node_builtin`, `has_fetch`, `has_dynamic_import`, `has_unsupported_import`, `unparseable` |
| `double1` | `1`                                                                                                                                                            |

No user, source, run, or request identity. Recording is a no-op without the
binding. Query with `sum(_sample_interval)`:

```sql
SELECT
  blob1 AS class,
  blob2 AS reason,
  SUM(_sample_interval) AS executes
FROM kody_execute_interpretable_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY class, reason
ORDER BY executes DESC
```

`q = interpretable / total` from that grouping, or
`sumIf(_sample_interval, blob1 = 'interpretable') / sum(_sample_interval)`.

## MCP search duration

Measurement-only Analytics Engine dataset for MCP `search` wall clock and the
exclusive tiles that should sum to it. This is **not** a `recordUsage()` event,
does not enter `usage_rollups`, and is not a UWD surface. Search-scope and
memory retrievers already mint `dynamic_worker_day` with surface `retriever`.
The write path lives in `packages/worker/src/mcp/tools/search-observability.ts`.

Production dataset `kody_mcp_search_events` (preview:
`kody_mcp_search_events_preview`). Binding `MCP_SEARCH_EVENTS` on origin and
platform (where MCP search runs). Schema:

| Field     | Value                                     |
| --------- | ----------------------------------------- |
| `index1`  | `mcp_search` (shared sampling population) |
| `blob1`   | `success` or `failure`                    |
| `blob2`   | `list`, `entity`, or `entity-batch`       |
| `blob3`   | intent task name, or empty                |
| `blob4`   | `trimmed` or `intact`                     |
| `blob5`   | `offline` or `online`                     |
| `double1` | `durationMs`                              |
| `double2` | `unaccountedMs`                           |
| `double3` | `loadAndRankMs`                           |
| `double4` | `waitingItemsMs`                          |
| `double5` | `memoryEnrichmentMs`                      |
| `double6` | `rowAndRegistryLoadMs`                    |
| `double7` | `retrieversMs`                            |
| `double8` | intent confidence (`-1` when unknown)     |
| `double9` | `trimmedMatchCount`                       |

No user, query, conversation, or request identity. Recording is a no-op without
the binding. Query with `_sample_interval` weights:

```sql
SELECT
  quantile(0.5)(double1) AS p50_ms,
  quantile(0.95)(double1) AS p95_ms,
  avg(double2) AS avg_unaccounted_ms,
  avg(double4) AS avg_waiting_ms,
  SUM(_sample_interval) AS calls
FROM kody_mcp_search_events
WHERE timestamp > NOW() - INTERVAL '1' HOUR
```

## Onboarding funnel

Best-effort Analytics Engine points for the signup-to-checkout funnel. Not a
`recordUsage()` event and not a UWD surface. First-seen stages also write the
matching `users.first_*_at` column so a repeat does not emit again. Recording
never throws and is a no-op without the binding.

Production dataset `kody_onboarding_funnel_events` (preview:
`kody_onboarding_funnel_events_preview`). Binding `ONBOARDING_FUNNEL_EVENTS` on
origin, platform, and runtime. Schema:

| Field     | Value                                                             |
| --------- | ----------------------------------------------------------------- |
| `index1`  | stable user id                                                    |
| `blob1`   | stage (`signup_started`, `first_search`, `checkout_completed`, …) |
| `blob2`   | MCP client family, sanitized waiting card id, or plan             |
| `blob3`   | `mcp_connect_failed` error class, otherwise empty                 |
| `blob4`   | sanitized OAuth client id (hostname when the id is a URL)         |
| `double1` | `1`                                                               |

No email, prompt, secret, or free-text error. `/admin/insights` reads unique
users per stage for 7 and 28 days with `count(DISTINCT index1)`. Those counts
are sampled, so they are a floor. Local dev and missing credentials render the
table empty.

```sql
SELECT
  blob1 AS stage,
  count(DISTINCT index1) AS users
FROM kody_onboarding_funnel_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY stage
```

## Reading the data

- Analytics Engine: query the `kody_usage_events` dataset (SQL API) filtered by
  the `index1` org billing id; blob/double positions are listed above. Remember
  that Analytics Engine samples: count with `sum(_sample_interval)` and sum
  values with `sum(doubleN * _sample_interval)`. Coalesced points store their
  unit count (RPCs or rows read) in `double3`, so those metrics' `event_count`
  is `sum(if(double3 > 0, double3, 1.0) * _sample_interval)` and `total_bytes`
  stays 0.
- D1: `SELECT * FROM usage_rollups WHERE user_id = ?1 AND month = ?2` gives
  every metric for a user's month in one small scan (`event_count`,
  `error_count`, `caught_count`, durations, bytes). Pre-migration rows and
  non-`package_static_call` metrics read `caught_count` as 0.
- Admin usage drill-down (admin users / orgs pages and MCP `adminUserUsage` /
  `adminOrgUsage`): `packages/worker/src/admin/user-usage-data.ts` (and
  `org-usage-data.ts`) caches its per-owner rollup read model for ~5 minutes in
  `BUNDLE_ARTIFACTS_KV` via the `@epic-web/cachified` adapter in
  `packages/worker/src/kv-cachified.ts` (key prefix `derived-cache:v1:`), keyed
  by owner id + current month, falling through to direct D1 queries when KV is
  unavailable. Each metric row includes `caughtCount` next to `errorCount` so
  handled static-call throws stay visible without inflating the fleet alert
  rate. Usage is loaded for one selected account at a time, so admin reads stay
  O(1) per view as the user base grows. Per-package caught detail remains in
  Analytics Engine (`blob3` entity id + `blob4 = 'caught'`).
- **Fleet visibility** (`/admin/insights`, loader in
  `packages/worker/src/admin/fleet-usage-insights.ts`): bounded SQL over
  `usage_rollups` for the current UTC month — top-10 combined runtime duration
  (execute + job_run + workflow_run), top-10 event counts (excluding
  observe-only `dynamic_worker_invoke` and Durable Object meters), per-metric
  duration leaders, and an entitlement-pressure panel that reuses
  `readAdminEntitlementConsumption` for the top ~15 users by those same customer
  event counts, passing each row's `orgs.entitlement_ladder` so legacy
  Standard/Pro is scored against `legacyPlanLimits`. Queries are
  `LIMIT`-bounded; entitlement reads run with modest concurrency.
- **Launch signals** (`/admin/insights`, loader in
  `packages/worker/src/admin/launch-signals.ts`): COUNT / GROUP BY over indexed
  `users` columns and `platform_feedback.status`. Rough MRR maps
  `orgs.stripe_price_id` through the known Standard/Pro catalog (public
  $12 /
  $120 and $49 / $480, plus retired list prices) and never calls Stripe
  or pages the user table. `plan`, `stripe_plan`, and overlay-aware
  `effectivePlan` stay separate so gift/referral Pro overlays do not look like
  paid MRR. Cost-vs-pay ranks the current month's top unique-worker-day
  consumers (bounded scan) and a Risk panel: catalog-paid accounts over list
  MRR, unpaid accounts at ≥$1 / 500 unique days (50% of the $2 / 1,000
  unique-day included-bucket alert), and Standard/Pro rows whose
  `stripe_price_id` is missing or not in the catalog. Free pennies, max, and
  `kentcdodds` are not tagged. Admin-role accounts stay out of the unpaid
  near-allotment warn bucket; catalog-paid admins over list MRR still appear as
  paid underwater. The 5-minute insights KV cache (`admin-insights:v11`) covers
  the assembled page; RunLog-derived charts come from the hourly RunLog KV
  snapshot.
- **Proactive alerts** (`usage_entitlement_alert` scheduled lane in
  `packages/worker/src/app/usage-entitlement-alerts.ts`): hourly sweep of the
  same ~15-user bound, scored against each account's **effective** plan
  (including temporary Pro gift / referral overlays). Inbound
  `email_receives_per_day` is the exception: inbound mail enforces that cap
  against the base (manual + Stripe) plan, so the sweep scores it the same way.
  Emits `fleet.entitlement.crossed` to admin-owned packages once when a swept
  account first crosses 80% or 100% of a plan-limit resource, when a non-admin
  account's combined execute, job_run, and workflow_run duration for the month
  first exceeds `fleetRuntimeDurationAlertThresholdMs` (24h), when a non-admin
  account's unique Dynamic Worker cost for the month first reaches the
  plan-aware threshold (Free $2 / 1,000 unique days, Standard
  $12, Pro $49), or
  when a non-admin account hits 100% of `execute_unique_workers_per_day` on
  three of the last seven UTC days. Staying over the same threshold does not
  emit again. Admin-role dogfooding stays on `/admin/insights` rankings and can
  still appear as an entitlement crossing, but does not page the
  runtime-duration, unique-worker-cost, or repeated- execute signals. KV prefix
  `fleet-entitlement-crossing:v1` claims each crossing. Execute-cap trains also
  write `fleet-entitlement-hit:v1` day keys so a later drop below 100% the same
  day does not erase the count. Admin links in the payload are built with
  `joinAppUrl` so a trailing slash on `APP_BASE_URL` cannot produce
  `https://host//admin/…`. See
  [Admin events](../../guides/admin-events.md#fleetentitlementcrossed-admins).
- **Fleet package error rate** (same `usage_aggregation` hour): a second
  Analytics Engine SQL, not grouped by user, totals `package_export`,
  `package_static_call`, `job_run`, and `workflow_run` for the last completed
  hour vs the hour before and the last 24 hours vs the 24 hours before. Error
  counts use `blob4 = 'error'` only — `caught` static-call outcomes are excluded
  from the rate and from concentration shares. The snapshot lives at the
  platform KV key `fleet-package-error-rate:v1` and feeds `/admin/insights`.
  When the combined rate rises past a volume floor, a third query ranks owners
  of recent-window errors. Shares use the anonymous window error total so a
  truncated owner sample cannot look like one account. One account at ≥80% of
  those errors, or three accounts together at ≥80%, is concentrated; otherwise
  the spike stays fleet-wide. A follow-up query then loads package ids only for
  the named owners. Kody still fans `fleet.package_error_rate.elevated` to
  admin-owned packages in every case. Concentrated payloads name usernames and
  package name leaves only. The KV cooldown key
  `ops-alert:fleet-package-error-rate:v1` stores structured state: hour
  elevations quiet for six hours, day elevations for 24 hours, and the same
  window end + top owner never re-pages. The payload has no user ids, package
  UUIDs, emails, or error strings. See
  [Admin events](../../guides/admin-events.md#fleetpackageerrorrateelevated-admins).

  Tracking: remove this elevated alert after `fleet.users_affected.elevated` has
  run ~1 week with sane behavior (owner spikes already notify publishers via
  `fleet.package_owner_error_spike`).

## Usage campaign

The hourly `usage_entitlement_alert` lane also runs the usage-state lifecycle
campaign (`sendUserUsageCampaignEmails`). One campaign state per user. The
evaluator branches on activation stamps and live reads (paged distinct inbound
`clientId`s, enabled jobs / last job run, execute-rollup depth, Stripe paid,
stock entitlement pressure). It is not a fixed week-1/3 calendar drip.

| State                  | Mail                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VerifiedNoMcp`        | Connect-an-agent template, 2 sends max                                                                                                                   |
| `ConnectedNoPackage`   | Save-a-package template (personalized with `mcp_client_name` when set), 2 sends                                                                          |
| `PackagedSingleClient` | Second-agent / portability template, 1–2 sends. Trial CTA only while the 14-day Pro gift is unreceived (`describeSecondAgentStandardGift` status `none`) |
| `Activated`            | Campaign silence. After ≥7 days, one `advocate_referral_testimonial` mail if not already sent                                                            |
| `Cooling`              | One “home’s still here” poke, then terminal quiet                                                                                                        |
| `LimitAware`           | Campaign silence; entitlement-warning mail owns the nudge                                                                                                |
| `Paid`                 | Campaign silence except the same one-shot advocate mail (1 forever). Billing transactional still owns paid-plan mail                                     |

`last_active_at` does not bump on `job_run`. Enabled jobs and `last_run_at` are
read separately so a quiet interactive user with a live schedule stays
Activated. Cooling requires stale `last_active_at` plus no job activity. When
both of those stamps are missing, the newest of `first_saved_package_at` /
`first_mcp_connected_at` is the fallback — a missing `last_active_at` is not
treated as 21 days stale. A failed jobs list does not count as "no jobs":
Activated and Cooling rows stay put, and Cooling is not mailed. First
observation still uses the stamp-based quiet check so a quiet packaged user
seeds `Cooling` instead of a later event transition that would backfill the
poke. Once a user has been `Activated` or `Cooling`, they do not fall back to
`PackagedSingleClient` mail when strong-use or client count dips — recent
activity returns them to Activated silence. `ever_activated` survives LimitAware
and Paid so those silent states cannot erase that history. A LimitAware snapshot
that already shows two clients, a live job, or strong use sets the flag even
when the resolved state is still LimitAware, so leaving the cap after a later
dip does not become PackagedSingleClient mail. LimitAware from VerifiedNoMcp
without those signals still leaves the flag off. Cooling is one lifetime poke:
`cooling_terminal` is sticky, so a later re-entry does not retry send 1 or stall
the sweep.

The advocate mail is not a drip and does not reopen Activated or Paid campaign
caps (those stay 0). Eligibility is current `Activated` or `Paid`, tenure of
seven days from `first_activated_at` (or `entered_at` when that stamp is not set
yet), a live referral `shareUrl` (`/signup?ref=<username>` from
`referralSharePath`), and no prior `advocate_referral_testimonial` ledger row.
Seed origin does not block it after tenure; first observation still only
persists. Tips opt-out suppresses it. The CTA is the account's referral invite
link; the secondary action is `mailto:me@kentcdodds.com` (the existing
testimonial channel — the homepage carousel has no intake form).

First sweep of an existing user seeds the current state without mailing
(backfill is out of scope). Verify-time connect-agent mail is send 1 of
`VerifiedNoMcp` (`origin=event`) and goes out during `GET /verify-email`, not on
a later cron. The handler resolves the sender with the same request URL the
verification mail uses, then passes the send to `waitUntil`. A floating promise
is cancelled when the verified page is returned, which drops the mail and never
opens the event-origin retry row; the next sweep then seeds the user and does
not backfill. Deleting the account afterward does not send or cancel that mail.
If the immediate send fails closed (no email config even with the request URL,
or a failed unsubscribe mint or Cloudflare send), the verify path still opens an
event-origin row with `send_count` 0 so the hourly sweep can retry after the
normal 24-hour first-send dwell instead of seeding the user permanently. Tips
opt-out skips the mail and does not open that row. The campaign upsert keeps
`MAX(send_count)` and the later `last_sent_at` when the state is unchanged, and
never downgrades `event` to `seed`, so a later sweep persist cannot clobber that
verify-time row. A real state change still resets `send_count`. Later sends wait
24 hours after a transition and 5 days between sends in the same state. The send
ledger claim is `INSERT OR IGNORE` on `(user_id, state, send_index)` and is
released if the Cloudflare send fails or unsubscribe-token minting fails (no
footerless campaign mail). A lost claim race does not persist a stale
`send_count`. Kit is not part of this machine.

Campaign mail is the only surface gated by the **Kody tips** preference
(`user_tips_email_opt_outs`). Each campaign send includes an “Unsubscribe from
tips” footer and RFC `List-Unsubscribe` / `List-Unsubscribe-Post` one-click
headers. The signed `/unsubscribe/tips` route sets that stamp; transactional
verify, billing, and error-rate mail is never suppressed. Distinct inbound
client counts come from `loadInboundMcpConnectionState`. A failed grant listing
does not treat the count as 0: packaged users without Activated history hold
`PackagedSingleClient` and persist without sending, so a later successful
listing stays a seed instead of an event backfill. A failed execute-rollup read
does not treat depth as 0: the same packaged row persists without sending, so a
later successful read can still become Activated silence instead of second-agent
mail.
