# Invocation overhead guardrails

The static-first package model rests on a performance claim: static
`kody:@scope/pkg/export` imports cost nothing at invocation time, and **package
export runs** (webhooks, jobs, subscriptions, and apps) stay lean enough (tens
of milliseconds of platform overhead) that agents never route around the
contract-checked path. Author composition is static import / `import(specifier)`
/ workflows ([0037](../decisions/0037-no-author-packages-invoke.md)). This
document records the guardrails that keep the hot-path claim true. It is about
platform overhead per call, not about what user code does inside the call.

## Per-call overhead budgets

- **Static imports** add zero platform cost at invocation time by construction:
  no dispatch, no contract check, no bookkeeping per call. Their costs are paid
  when the caller is bundled — at publish time for packages (typecheck, repo
  checks, artifact rebuild), and inside the per-call bundle step that ad hoc
  execute already pays regardless of imports. Do not add per-call bookkeeping to
  the static import path.
- **Keyless package export runs** (`invokePackageExport` / host
  `runSavedPackageModule` without an idempotency key) are the lean/ephemeral
  mode: contract check plus dispatch into the target package's own runtime, no
  idempotency ledger row, run records on-failure-only. Their hot path budget is
  **tens of milliseconds** of platform overhead per call. Work that would push
  them beyond that (extra D1 round trips, eager run-record writes, synchronous
  vector or KV lookups) belongs in the keyed mode or off the hot path
  (`waitUntil`).
- **Keyed package export runs** deliberately pay for durability: a ledger claim,
  eager run records, and a bounded response snapshot for replay. That cost is
  the feature; it must never silently leak into the keyless mode. The ledger
  lives in the per-user `RunLog` Durable Object (see
  [Run records](./run-records.md)), so the durability cost is **one awaited DO
  call for claim + run-record begin and one for terminal response + run-record
  finish** — no D1 round trips at all.
- **Package-app HTTP** (`servePackageAppRequest` / `app_fetch`) is the same
  class of hot path as keyless export runs: a hello-world `fetch` that returns
  `ok` should not pay tens of milliseconds of platform overhead on a warm
  isolate. The serve path shares the invoke freshness/commit caches, and must
  not await the run-record begin RPC before user `fetch`. Finish already upserts
  a complete row, so a dropped `running` insert is harmless. Hosted serve and
  package-app origin host setup emit request-scoped `Server-Timing` phases
  (`owner`, `resolveSavedPackage`, `manifest`, `usageGate`, `appLoader`,
  `entrypoint`) via the same helper pages use, so warm overhead can be
  attributed per phase without a separate benchmark harness. WebSocket upgrades
  skip `Server-Timing`: Durable Object 101 responses have immutable headers, and
  rebuilding them without the paired `webSocket` is invalid.

## Per-isolate caches and their staleness bounds

The keyless package-export contract check (saved-package row, entity-source row,
manifest, bundle artifact) and package-app HTTP serve (saved-package row,
entity-source row, manifest) are cached per isolate so a warm call of an
already-warm package+commit performs **zero D1/KV loads** before dispatch. The
caches come in two tiers with different correctness arguments (see
`packages/worker/src/package-invocations/invoke-contract-cache.ts`):

- **Freshness tier** — saved-package row and entity-source row (the row that
  carries `published_commit`), TTL **15 s**. This TTL is the republish staleness
  bound: after a republish, rename, or delete, another isolate may serve the
  previous contract for at most 15 s. The isolate that runs the projection
  refresh / delete invalidates eagerly, so it observes the change immediately.
  Cache misses (unknown package) are never retained, so a just-saved package is
  visible on the next lookup.
- **Commit tier** — manifest and prepared bundle artifact, keyed by
  `published_commit` taken from the freshness tier. A commit's artifacts are
  immutable, so these entries are never a staleness source; their TTL only
  bounds isolate memory.
- **Registry source lists** — enabled MCP-server refs, per-user TTL **30 s**
  with eager invalidation on mutation, matching the existing MCP hub snapshot
  bounds. Package-app entrypoints preload that list only when authored modules
  statically reference `kody.mcp`; hello-world and other non-MCP apps pass a
  lazy loader so `listMcpServerNames` runs only if author code first touches
  `kody.mcp`.
- **Package-app owner row** — per-`stableUserId` user snapshot for
  `resolvePackageAppOwnerByStableUserId`, TTL **15 s** (same clock as invoke
  freshness). Each request still re-applies suspend, deletion-fence, and
  password-change checks against the cached row; account-state and identity
  writes invalidate eagerly (admin suspend/unsuspend, deletion fence, password
  stamp, username/email change, user hard-delete). Cache misses (unknown user)
  are never retained.

Rules for touching these paths: publish and rebuild flows must keep using the
uncached row/manifest loaders (`loadPackageManifestBySourceId`,
`loadPackageSourceBySourceId`) so a rebuild can never run against a stale
`published_commit`; package-app HTTP serve must keep using the cached invoke
loaders (`resolveSavedPackage`, `loadInvokeManifestBySourceId`); every cache key
must start with the owning `userId` (per user isolation is inviolable); and new
caches on invocation paths need an explicit staleness bound documented here.

## Cold first-dispatch sample

The first `kody.*` capability RPC in an isolate logs
`kody-first-capability-dispatch-slow` when wall time is at least 250ms. That
probe is for production isolate logs. Workers-unit keeps per-file isolation
([decision 0011](../decisions/0011-workers-unit-pool-harness.md)), so the same
threshold is not a test assertion. Vitest skips the warn so CI load cannot fail
the console spy.

## Watch the percentiles

Every invocation surface is metered through `recordUsage()` (see
[Usage metering](./usage-metering.md)); events land in the `kody_usage_events`
Analytics Engine dataset with per-surface `eventType` values. The mapping that
matters here: keyless package-export target runs are saved-package bundled runs,
so they land under the `package_export` event type (`entityId` = package id),
while the calling surface reports its own event type (`execute`, `job_run`,
`workflow_run`). When touching an invocation path, watch the `durationMs`
percentiles (p50/p95/p99) of the affected event types before and after the
change rather than reasoning from a single local timing. A regression in the
`package_export` or `execute` percentiles is a release blocker for the change
that caused it, not a follow-up.

## New awaited D1 writes need a budget justification

Any change that adds an **awaited D1 write** to a hot invocation path (ad hoc
execute, keyless package export runs, subscription dispatch) must include an
explicit budget justification in its PR description: what the write costs at
p95, why it cannot be deferred with `waitUntil`, batched, or moved to the
keyed/durable mode, and which surface percentile it is expected to move.
Reviewers should treat an unexplained new awaited write on these paths as a
defect.

Failure-path writes (error run records) and keyed-mode writes (ledger claim,
eager run records) are already part of their respective budgets and do not need
per-PR justification.
