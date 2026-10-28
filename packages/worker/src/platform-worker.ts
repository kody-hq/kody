import * as Sentry from '@sentry/cloudflare'
import {
	buildPlatformWorkerHealth,
	platformWorkerHealthPath,
} from '@kody-internal/shared/platform-worker.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { DynamicWorkerUsageTail } from '#worker/usage/dynamic-worker-cpu.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { refuseNonCanonicalProductionHost } from '#app/canonical-host.ts'
import { McpClientHub } from './mcp-client/hub.ts'
import { MCP } from './mcp/index.ts'
import { UserMeter } from './entitlements/user-meter-do.ts'
import { StripePlanRefresh } from './billing/stripe-plan-refresh-do.ts'
import { Mailbox } from './email/mailbox-do.ts'
import { RepoSession } from './repo/repo-session-do.ts'
import { RepoSessionIndex } from './repo/repo-session-index-do.ts'
import { OAuthPurgeCoordinator } from './oauth-purge.ts'
import { ExecutionContextSessionV1 } from './execution-contexts/session-do.ts'
import { getWorkerSentryOptions } from './sentry-options.ts'

/**
 * Platform Worker entrypoint (script `kody-platform`, deployed from
 * `packages/platform-worker/wrangler.jsonc`).
 *
 * Owns the remaining platform Durable Objects extracted from the origin
 * `kody` Worker per ADR 0034 so content/UI deploys of the origin script do
 * not reset those objects. HTTP on this script is the deploy healthcheck
 * only; MCP HTTP, OAuth, email, and the Remix app stay on the origin and
 * reach these classes through cross-script bindings.
 *
 * `KodyFetchGateway` and `PackageAppRuntimeBridge` are loopback
 * `ctx.exports` WorkerEntrypoints. MCP `execute` (and the search/execute
 * graph that fans into it) runs inside the platform-owned `MCP` Durable
 * Object and looks up those exports on **this** script, the same way
 * `kody-runtime` exports its own gateway instead of calling back into origin.
 */
export {
	MCP,
	McpClientHub,
	OAuthPurgeCoordinator,
	UserMeter,
	Mailbox,
	RepoSession,
	RepoSessionIndex,
	StripePlanRefresh,
	ExecutionContextSessionV1,
	KodyFetchGateway,
	DynamicWorkerUsageTail,
	PackageAppRuntimeBridge,
}

const platformWorkerHandler = {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url)

		const nonCanonicalHost = refuseNonCanonicalProductionHost({
			request,
			env,
			allowedHealthPath: platformWorkerHealthPath,
		})
		if (nonCanonicalHost) return nonCanonicalHost

		if (url.pathname === platformWorkerHealthPath) {
			return Response.json(
				buildPlatformWorkerHealth({
					commitSha: (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA,
					cookieSecretConfigured: Boolean(env.COOKIE_SECRET?.trim()),
				}),
			)
		}

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<Env>

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	platformWorkerHandler,
)
