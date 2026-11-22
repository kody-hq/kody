import type { EcpPublishBuildSource } from '@kody-internal/shared/execution-context-protocol/index.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { Duration, Effect } from 'effect'
import { outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import {
	PublishContextFromContextRun,
	PublishContextNeedsPerson,
	PublishContextTimedOut,
	PublishContextUnavailable,
} from '#worker/publish-offload/errors.ts'
import { routeExecute } from './routing.ts'

/** How long past the run's own limit before the routed call is abandoned. */
const routeExecuteGrace = Duration.seconds(30)

type RoutedRunResult = Extract<
	Awaited<ReturnType<typeof routeExecute>>,
	{ kind: 'ran' }
>['result']

export type RoutedPublishBuild =
	| { kind: 'cloud' }
	| { kind: 'context'; result: RoutedRunResult; contextName: string }

const timedOut = (contextName: string) =>
	new PublishContextTimedOut({
		message: `The publish build on ${contextName} did not finish in time.`,
	})

/**
 * Publish offload: send a builder run to an execution context through the
 * same chain, lease, and dispatch path as `execute`. The run carries the
 * daemon's builder (not user code), no credential picks, and only contexts
 * the requester operates may take it (4A). A named context never falls back.
 * Without `fallbackToCloud`, nothing falls back to Kody cloud (the caller
 * asked for a context build); with it, a chain that ends in Kody cloud
 * returns `{ kind: 'cloud' }` so the caller publishes on Kody cloud.
 */
export const routePublishBuild = Effect.fn(
	'ExecutionContexts.routePublishBuild',
)(function* (input: {
	request: RequestContext
	apiUrl: string
	context: string | null
	source: EcpPublishBuildSource
	limits: { timeoutMs: number; memoryMb: number }
	fallbackToCloud?: boolean
}) {
	const request = input.request
	const actor = request.actor
	if (!actor) {
		return yield* new PublishContextNeedsPerson({
			message: 'Building on an execution context needs a signed-in person.',
		})
	}
	if (request.credential.kind === 'execution-context-run') {
		return yield* new PublishContextFromContextRun({
			message:
				'A context run cannot start a publish build. Run `kody package publish --build context` from your own machine.',
		})
	}
	const env = yield* WorkerEnv
	const profileAccess = request.credential.profileId
		? yield* outbound('authorization.effective_permissions', () =>
				computeEffectivePermissions({ env, request }),
			)
		: null
	const runId = yield* Effect.sync(() => crypto.randomUUID())
	const outcome = yield* outbound(
		'execution_contexts.route_execute',
		(signal) =>
			routeExecute({
				env,
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
				runId,
				runRecord: null,
				code: null,
				params: {},
				credentials: null,
				apiUrl: input.apiUrl,
				waitMs: input.limits.timeoutMs,
				signal,
				publishBuild: { source: input.source, limits: input.limits },
			}),
		{
			timeout: Duration.sum(
				Duration.millis(input.limits.timeoutMs),
				routeExecuteGrace,
			),
		},
	).pipe(
		Effect.mapError((error) =>
			error.reason === 'timeout'
				? timedOut(input.context ?? 'an execution context')
				: error,
		),
	)
	if (outcome.kind === 'cloud' && input.fallbackToCloud) {
		const routed: RoutedPublishBuild = { kind: 'cloud' }
		return routed
	}
	if (outcome.kind === 'cloud' || outcome.kind === 'queued') {
		return yield* new PublishContextUnavailable({
			message:
				'No execution context you operate could take this publish build. Start one with `kody context start`, or build on this machine with `kody package publish --build local`.',
		})
	}
	if (outcome.kind === 'pending') {
		return yield* timedOut(String(outcome.metadata.name))
	}
	const routed: RoutedPublishBuild = {
		kind: 'context',
		result: outcome.result,
		contextName: outcome.metadata.name ?? 'an execution context',
	}
	return routed
})
