import { McpClientHub } from './mcp-client/hub.ts'
import { MCP } from './mcp/index.ts'
import { JobsHost } from './jobs/jobs-host.ts'
import { KodyApi } from './open-api/kody-api.ts'
import { StorageRunner } from './storage-runner.ts'
import { RunLog } from './run-records/run-log-do.ts'
import { UserMeter } from './entitlements/user-meter-do.ts'
import { StripePlanRefresh } from './billing/stripe-plan-refresh-do.ts'
import { Mailbox } from './email/mailbox-do.ts'
import { RepoSession } from './repo/repo-session-do.ts'
import { RepoSessionIndex } from './repo/repo-session-index-do.ts'
import { PackageRealtimeSession } from '#worker/package-runtime/realtime-session.ts'
import { DynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { DynamicWorkerUsageTail } from '#worker/usage/dynamic-worker-cpu.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { OAuthPurgeCoordinator } from './oauth-purge.ts'
import { ExecutionContextSessionV1 } from './execution-contexts/session-do.ts'
import { originWorkerHandler } from './origin-handler.ts'

/**
 * Dev/test origin entry. `env.test` (local dev, workers-unit, Playwright)
 * inherits this top-level `main`: it has no separate platform/runtime/jobs
 * scripts, so this single script owns every Durable Object and
 * `ctx.exports` WorkerEntrypoint locally (no `script_name` on any binding).
 *
 * Deployed environments use the slimmer `production-worker.ts` entry from a
 * deploy-generated Wrangler config:
 *
 * - Production (`tools/ci/production-resources.ts`) only when the origin
 *   script is already in steady state (platform/runtime own the transferred
 *   classes). A fresh production script still deploys this full entry first
 *   so `new_sqlite_classes` can replay before the transfer.
 * - Preview (`tools/ci/preview-resources.ts`) always: the per-PR platform
 *   and runtime scripts create their own classes, so the preview origin
 *   never owns one and never bootstraps. This full entry is only the
 *   fallback for a preview origin created before that topology that still
 *   owns transferred classes.
 *
 * See `tools/ci/origin-production-deploy-state.ts`.
 */
export {
	RepoSession,
	RepoSessionIndex,
	KodyFetchGateway,
	DynamicWorkerUsageTail,
	McpClientHub,
	MCP,
	JobsHost,
	KodyApi,
	PackageRealtimeSession,
	DynamicCallableWorkflow,
	PackageAppRuntimeBridge,
	StorageRunner,
	RunLog,
	UserMeter,
	StripePlanRefresh,
	Mailbox,
	OAuthPurgeCoordinator,
	ExecutionContextSessionV1,
}

export default originWorkerHandler
