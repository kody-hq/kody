import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { DynamicWorkerUsageTail } from '#worker/usage/dynamic-worker-cpu.ts'
import { JobsHost } from './jobs/jobs-host.ts'
import { KodyApi } from './open-api/kody-api.ts'
import { originWorkerHandler } from './origin-handler.ts'

/**
 * Slim origin Worker entrypoint: production (script `kody-production`) and
 * preview (`kody-pr-<n>`).
 *
 * The committed `packages/worker/wrangler.jsonc` never points any
 * environment's `main` here. `tools/ci/production-resources.ts` overrides
 * the generated config's top-level `main` only after
 * `tools/ci/origin-production-deploy-state.ts` classifies the live origin
 * script as steady-state (platform and runtime already own every
 * transferred class). Fresh production scripts keep `index.ts` so historical
 * `new_sqlite_classes` can replay. Ambiguous Cloudflare state also keeps
 * `index.ts` (fail closed). `tools/ci/preview-resources.ts` uses this entry
 * for every preview origin that owns no transferred class (a fresh per-PR
 * fleet has no storage to transfer, so it never bootstraps) and strips the
 * origin's Durable Object migrations from the generated preview config.
 *
 * ADR 0034: origin owns zero Durable Object classes in production and
 * preview. Every env.production and env.preview `durable_objects` binding
 * sets `script_name` (kody-platform or kody-runtime) and the `workflows`
 * binding does too, so none of those classes need a local export here — only
 * `index.ts` (dev/test, fresh/ambiguous production, and legacy preview
 * origins) does.
 *
 * The exports kept here are `ctx.exports` WorkerEntrypoint contracts
 * production genuinely calls on this script:
 * - `KodyFetchGateway` — the origin-only `/__maintenance/execute-smoke`
 *   deploy check (see `execute-maintenance.ts`) proves this script's own
 *   loopback export. MCP `execute` itself runs on `kody-platform` and looks
 *   up its own gateway there, not through this script.
 * - `JobsHost` — `kody-jobs`' `HOST` service binding calls back into this
 *   script for job execution (see
 *   docs/contributing/architecture/jobs-worker-migration-runbook.md).
 * - `KodyApi` — `kody-api`'s `KODY_API` service binding forwards
 *   `api.kody.codes` requests here (see
 *   docs/contributing/architecture/open-api.md).
 * - `DynamicWorkerUsageTail` — tail worker attached to the Worker Loader
 *   isolates those jobs (and the execute smoke) create, recording
 *   Cloudflare-measured CPU as `dynamic_worker_cpu`.
 *
 * Everything else `index.ts` exports (MCP, McpClientHub,
 * OAuthPurgeCoordinator, UserMeter, Mailbox, RepoSession, RepoSessionIndex,
 * StripePlanRefresh, StorageRunner, RunLog, PackageRealtimeSession,
 * DynamicCallableWorkflow, PackageAppRuntimeBridge) is reached in
 * steady-state production only through cross-script bindings or the
 * `RUNTIME_WORKER` service forward, never through a local export on this
 * script.
 * Permanent: stored data or clients from before this change still exist.
 */
export { KodyFetchGateway, JobsHost, KodyApi, DynamicWorkerUsageTail }

export default originWorkerHandler
