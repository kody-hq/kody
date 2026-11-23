import type { EcpPublishBuildSource } from '@kody-internal/shared/execution-context-protocol/index.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import {
	assertNever,
	catchDeadline,
	type DeadlineFailure,
} from '#worker/outbound/typed-failure.ts'
import {
	type DeadlineClock,
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { ExecutionContextError } from './errors.ts'
import { routeExecute } from './routing.ts'

/** Why a publish build could not run on an execution context. */
export type RoutePublishBuildFailure =
	| { kind: 'needs_person' }
	| { kind: 'context_run_caller' }
	| { kind: 'no_context_available' }
	| { kind: 'context_timed_out'; contextName: string | null }
	| DeadlineFailure

export function mapRoutePublishBuildFailure(
	failure: RoutePublishBuildFailure,
): ExecutionContextError {
	switch (failure.kind) {
		case 'needs_person':
			return new ExecutionContextError({
				status: 401,
				code: 'insufficient_scope',
				message: 'Building on an execution context needs a signed-in person.',
			})
		case 'context_run_caller':
			return new ExecutionContextError({
				status: 403,
				code: 'insufficient_scope',
				message:
					'A context run cannot start a publish build. Run `kody package publish --build context` from your own machine.',
			})
		case 'no_context_available':
			return new ExecutionContextError({
				status: 409,
				code: 'execution_context_unavailable',
				message:
					'No execution context you operate could take this publish build. Start one with `kody context start`, or build on this machine with `kody package publish --build local`.',
			})
		case 'context_timed_out':
			return new ExecutionContextError({
				status: 504,
				code: 'execution_context_unavailable',
				message: `The publish build on ${failure.contextName} did not finish in time.`,
			})
		case 'deadline_exceeded':
			return new ExecutionContextError({
				status: 503,
				code: 'execution_context_unavailable',
				message: `Kody storage did not answer in time (${failure.label} exceeded ${failure.timeoutMs}ms). Run the publish again in a moment.`,
			})
		default:
			return assertNever(failure, 'route publish build failure')
	}
}

/**
 * Routes a publish builder run through the `execute` chain and lease path.
 *
 * See `routeExecute` for eligibility checks. A named context is the sole
 * target. When the chain selects cloud, `fallbackToCloud` lets the caller
 * handle that outcome.
 */
export async function routePublishBuild(input: {
	env: Env
	request: RequestContext
	apiUrl: string
	context: string | null
	source: EcpPublishBuildSource
	limits: { timeoutMs: number; memoryMb: number }
	/** Ceiling for the whole routed run; sits past `limits.timeoutMs`. */
	runDeadlineMs: number
	fallbackToCloud?: boolean
	signal?: AbortSignal
	clock?: DeadlineClock
}): Promise<
	| RoutePublishBuildFailure
	| { kind: 'cloud' }
	| {
			kind: 'context'
			result: Extract<
				Awaited<ReturnType<typeof routeExecute>>,
				{ kind: 'ran' }
			>['result']
			contextName: string
	  }
> {
	const request = input.request
	const actor = request.actor
	if (!actor) return { kind: 'needs_person' }
	if (request.credential.kind === 'execution-context-run') {
		return { kind: 'context_run_caller' }
	}
	const outcome = await catchDeadline(async () => {
		const profileAccess = request.credential.profileId
			? await withDeadline(
					{
						label: 'publish_build.effective_permissions',
						timeoutMs: outboundTimeoutMs.d1,
						clock: input.clock,
					},
					() => computeEffectivePermissions({ env: input.env, request }),
				)
			: null
		return await withDeadline(
			{
				label: 'execution_context.publish_build_run',
				timeoutMs: input.runDeadlineMs,
				clock: input.clock,
			},
			(signal) =>
				routeExecute({
					env: input.env,
					request: {
						userId: actor.userId,
						handle: actor.username ?? null,
						orgId: request.org.id,
						orgSlug: request.org.slug ?? null,
						scopes: (request.credential.scopes as Array<string> | null) ?? null,
						credentialKind: request.credential.kind,
						profileAccess,
						profileId: request.credential.profileId ?? null,
					},
					args: input.context ? { context: input.context } : {},
					runId: crypto.randomUUID(),
					runRecord: null,
					code: null,
					params: {},
					credentials: null,
					apiUrl: input.apiUrl,
					waitMs: input.limits.timeoutMs,
					signal: input.signal
						? AbortSignal.any([input.signal, signal])
						: signal,
					publishBuild: { source: input.source, limits: input.limits },
				}),
		)
	})
	if (outcome.kind === 'deadline_exceeded') return outcome
	if (outcome.kind === 'cloud' && input.fallbackToCloud) {
		return { kind: 'cloud' }
	}
	if (outcome.kind === 'cloud' || outcome.kind === 'queued') {
		return { kind: 'no_context_available' }
	}
	if (outcome.kind === 'pending') {
		return { kind: 'context_timed_out', contextName: outcome.metadata.name }
	}
	return {
		kind: 'context',
		result: outcome.result,
		contextName: outcome.metadata.name ?? 'an execution context',
	}
}
