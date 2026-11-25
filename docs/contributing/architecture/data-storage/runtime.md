# Storage runtime and configuration

[Data storage overview](./index.md)

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
  [Run records](../run-records.md).
- `UserMeter` — `userMeterDurableObjectName(userId)` → `idFromName(userId)`. One
  daily-entitlement meter DO per user (untrimmed stable id, same as `RunLog`)
  with authoritative schema-v4 storage-byte state. See
  [Entitlements](../entitlements.md#usermeter).
- `StripePlanRefresh` — `stripePlanRefreshDurableObjectName(userId)` →
  `idFromName(userId)`. One ephemeral, one-shot reconciliation alarm per user;
  checkout and subscription webhook activity arm it as a backstop to the
  immediate Stripe refresh. Account deletion cancels and purges the alarm.
- `Mailbox` — `mailboxDurableObjectName(userId)` → `idFromName(userId)`. One
  email-metadata DO per user (untrimmed stable id, same as `RunLog`). See
  [Mailbox](services.md#durable-objects-mailbox).
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
from origin — see [ADR 0016](../../decisions/0016-mono-worker-extraction.md).
Platform Durable Objects (`MCP`, `McpClientHub`, `OAuthPurgeCoordinator`,
`UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`,
`FileStore`) live on the platform worker and are bound cross-script from origin
and runtime — see
[ADR 0034](../../decisions/0034-origin-owns-no-durable-objects.md). The origin
script owns no Durable Object classes.

- `APP_DB` (D1)
- `AUDIT_DB` (D1, global hashed security audit trail)
- `JOBS` (service binding to the jobs worker `JobsService` entrypoint)
- `OAUTH_KV` (KV)
- `BUNDLE_ARTIFACTS_KV` (KV)
- `EMAIL_BLOBS` (R2, raw email MIME blobs)
- `FILE_BLOBS` (R2, immutable org-file revision bytes)
- `OPERATOR_BACKUPS` (R2, operator rollback snapshots such as org resource
  transfer backups)
- `REPO_SESSION_BLOBS` (R2, ephemeral RepoSession Workspace spill; not a DR
  canonical store)
- `MCP_OBJECT` (Durable Objects; class hosted on the platform worker)
- `RUN_LOG` (Durable Objects; per-user run records — see
  [Run records](../run-records.md); class hosted on the runtime worker)
- `USER_METER` (Durable Objects; per-user daily entitlement counters — see
  [Entitlements](../entitlements.md#usermeter); class hosted on the platform
  worker)
- `STRIPE_PLAN_REFRESH` (Durable Objects; per-user, activity-driven Stripe plan
  reconciliation alarms; class hosted on the platform worker)
- `MAILBOX` (Durable Objects; sole per-user email graph, inbound-ledger,
  retention, read, export, and mutation authority — see
  [Mailbox](services.md#durable-objects-mailbox); class hosted on the platform
  worker)
- `FILE_STORE` (Durable Objects; per-owner org file catalog and quota
  coordinator; class hosted on the platform worker. File bytes live in
  `FILE_BLOBS`.)
- `STORAGE_RUNNER` (Durable Objects; class hosted on the runtime worker)
- `REPO_SESSION` (Durable Objects; class hosted on the platform worker)
- `REPO_SESSION_INDEX` (Durable Objects; per-user repo session catalog hosted on
  the platform worker. The runtime worker binds this class cross-script so
  package and workflow capability calls can open, list, and publish repo
  sessions.)
- `PACKAGE_REALTIME_SESSION` (Durable Objects; class hosted on the runtime
  worker)
- `MCP_CLIENT_HUB` (Durable Objects; user-added remote MCP servers — see
  [MCP client servers](../mcp-client-servers.md); class hosted on the platform
  worker)
- `OAUTH_PURGE_COORDINATOR` (Durable Objects; class hosted on the platform
  worker)
- `COMMUNITY_ASSETS` (R2; community listing assets)
- `CAPABILITY_VECTOR_INDEX` (Vectorize; capability/memory/job/package vectors)
- `ASSETS` (static assets bucket)
- `USAGE_EVENTS` (Analytics Engine dataset, production/preview only; see
  [Usage metering](../usage-metering.md))
- `EMAIL_EVENTS` (Analytics Engine dataset, production/preview only; indexed by
  stable user id and read only through role-gated platform aggregates)
- `MCP_PROTOCOL_EVENTS` (Analytics Engine dataset, production/preview only): one
  point per authenticated `/mcp` request recording which protocol lane served it
  (sessionful Durable Object vs stateless SDK) and, on `tools/call`, blob8
  package-identity param class (`kody_id` / `package_id` / `name` / `both` /
  `none`). In
  [protocol metrics](../../../../packages/worker/src/mcp/protocol-metrics.ts),
  blob9 is `declared` when that request advertises MCP Events in its client
  capabilities, otherwise empty. The
  [client-support readout](../../../../packages/worker/src/feature-flags/mcp-events-client-support-readout.ts)
  also uses Events RPCs and subscriptions; an empty blob alone does not mean the
  client lacks support.
- `EXECUTE_INTERPRETABLE_EVENTS` (Analytics Engine dataset, production/preview
  only; one point per MCP execute-tool module classifying whether it is
  interpretable pure glue for fleet `q`; see
  [Usage metering](../usage-metering.md#execute-interpretable-share-q))
- `MCP_SEARCH_EVENTS` (Analytics Engine dataset, production/preview only; one
  point per MCP `search` call with wall clock, exclusive-tile remainder, and
  intent/trim signals; see
  [Usage metering](../usage-metering.md#mcp-search-duration))
- `D1_REPLICA_READ_EVENTS` (Analytics Engine dataset, production/preview only;
  one point per request that read a D1 replica: retry reason, 5xx, document
  route failure, colo; the `d1_replica_read_alert` lane reads it, see
  [Admin events](../../../guides/admin-events.md#d1replica_readsalert-admins))
- `ONBOARDING_FUNNEL_EVENTS` (Analytics Engine dataset, production/preview only;
  one best-effort point per onboarding stage, indexed by stable user id, no
  prompts or secrets; admin insights reads unique users for 7 and 28 days. See
  [Usage metering](../usage-metering.md#onboarding-funnel))

`packages/worker/wrangler.jsonc` also configures the `EMAIL` send binding,
dispatch queues, worker loaders (`LOADER` / `APP_LOADER`), the `AI` binding, and
`DYNAMIC_CALLABLE_WORKFLOWS`; the Wrangler config is authoritative.
