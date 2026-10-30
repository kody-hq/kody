import * as Sentry from '@sentry/cloudflare'
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	buildRuntimeWorkerHealth,
	runtimeWorkerHealthPath,
	type RuntimePackageAppServeInput,
	type RuntimeWorkerServiceContract,
} from '@kody-internal/shared/runtime-worker.ts'
import { StorageRunner } from './storage-runner.ts'
import { RunLog } from './run-records/run-log-do.ts'
import { PackageRealtimeSession } from '#worker/package-runtime/realtime-session.ts'
import { DynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { servePackageAppRequest } from '#worker/package-runtime/package-app-serve.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { DynamicWorkerUsageTail } from '#worker/usage/dynamic-worker-cpu.ts'
import { getWorkerSentryOptions } from './sentry-options.ts'
import {
	handlePackageAppRequest,
	isPackageAppRequestPath,
} from '#app/handlers/package-app.ts'
import {
	handlePackageAppOriginRequest,
	resolveVerifiedCustomHostnameIfEnabled,
} from '#app/package-app-origin.ts'
import {
	isAllowedRequestHost,
	refuseNonCanonicalProductionHost,
} from '#app/canonical-host.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#worker/dynamic-worker-evaluation-budget.ts'

/**
 * Package runtime Worker entrypoint (script `kody-runtime`, deployed from
 * `packages/runtime-worker/wrangler.jsonc`).
 *
 * Owns the untrusted-code execution lane extracted from the main `kody`
 * Worker per ADR 0016: the package-app origin (`PACKAGE_APP_BASE_URL`),
 * inline package-app serving, dynamic callable workflows, and the runtime
 * Durable Objects exported below. The main Worker
 * forwards runtime-owned requests here over the `RUNTIME_WORKER` service
 * binding (see `runtime-worker-routing.ts` and
 * `@kody-internal/shared/runtime-worker.ts`).
 *
 * `KodyFetchGateway` and `PackageAppRuntimeBridge` are loopback
 * `ctx.exports` entrypoints for dynamically loaded package isolates, so this
 * script exports its own instances rather than calling back into the main
 * Worker.
 *
 * `RuntimeWorkerService` is the named `RUNTIME_WORKER` entrypoint: `.fetch`
 * keeps wholesale HTTP forward, and `servePackageApp` serves package apps for
 * slim-origin callers that lack `PackageAppRuntimeBridge` (ADR 0034).
 */
export {
	StorageRunner,
	RunLog,
	PackageRealtimeSession,
	DynamicCallableWorkflow,
	PackageAppRuntimeBridge,
	KodyFetchGateway,
	DynamicWorkerUsageTail,
}

/**
 * Named entrypoint for the origin `RUNTIME_WORKER` service binding.
 */
export class RuntimeWorkerService
	extends WorkerEntrypoint<Env>
	implements RuntimeWorkerServiceContract
{
	async fetch(request: Request): Promise<Response> {
		// Reuse the same Sentry wrap as the default export so wholesale
		// runtime-owned traffic keeps exception capture via this named entrypoint.
		return Sentry.withSentry((env: Env) => getWorkerSentryOptions(env), {
			async fetch(request: Request, env: Env, ctx: ExecutionContext) {
				return runWithDynamicWorkerEvaluationBudget(
					async () => await fetchRuntimeWorkerRequest(request, env, ctx),
				)
			},
		}).fetch(request, this.env, this.ctx)
	}

	async servePackageApp(input: RuntimePackageAppServeInput): Promise<Response> {
		return runWithDynamicWorkerEvaluationBudget(
			async () =>
				await servePackageAppRequest({
					request: input.request,
					env: this.env,
					owner: input.owner,
					visitor: input.visitor,
					identity: input.identity ?? null,
					consentPrincipal: input.consentPrincipal ?? null,
					approvedPublishedCommit: input.approvedPublishedCommit,
					packagePath: input.packagePath,
					dispatch: input.dispatch,
				}),
		)
	}
}

const runtimeWorkerHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return runWithDynamicWorkerEvaluationBudget(
			async () => await fetchRuntimeWorkerRequest(request, env, ctx),
		)
	},
} satisfies ExportedHandler<Env>

async function fetchRuntimeWorkerRequest(
	request: Request,
	env: Env,
	ctx: Pick<ExecutionContext, 'waitUntil'>,
) {
	const url = new URL(request.url)

	if (
		url.pathname === runtimeWorkerHealthPath &&
		isAllowedRequestHost({
			request,
			env,
			allowedHealthPath: runtimeWorkerHealthPath,
		})
	) {
		return Response.json(
			buildRuntimeWorkerHealth({
				commitSha: (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA,
				cookieSecretConfigured: Boolean(env.COOKIE_SECRET?.trim()),
			}),
		)
	}

	const nonCanonicalHost = refuseNonCanonicalProductionHost({
		request,
		env,
		allowedHealthPath: runtimeWorkerHealthPath,
	})
	if (nonCanonicalHost) {
		// Customer custom hostnames are not in the sync allowlist. Let a
		// verified app binding through; everything else keeps the 404.
		const customHostname = await resolveVerifiedCustomHostnameIfEnabled(
			request,
			env,
		)
		if (!customHostname) return nonCanonicalHost
	}

	const packageAppOriginResponse = await handlePackageAppOriginRequest(
		request,
		env,
		ctx,
	)
	if (packageAppOriginResponse) return packageAppOriginResponse

	if (isPackageAppRequestPath(url.pathname)) {
		return handlePackageAppRequest(request, env)
	}

	return new Response('Not Found', { status: 404 })
}

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	runtimeWorkerHandler,
)
