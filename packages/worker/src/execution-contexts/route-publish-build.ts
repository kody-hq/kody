import type { EcpPublishBuildSource } from '@kody-internal/shared/execution-context-protocol/index.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import { ExecutionContextError } from './errors.ts'
import { routeExecute } from './routing.ts'

/**
 * Publish offload: send a builder run to an execution context through the
 * same chain, lease, and dispatch path as `execute`. The run carries the
 * daemon's builder (not user code), no credential picks, and only contexts
 * the requester operates may take it (4A). A named context never falls back.
 * Without `fallbackToCloud`, nothing falls back to Kody cloud (the caller
 * asked for a context build); with it, a chain that ends in Kody cloud
 * returns `{ kind: 'cloud' }` so the caller publishes on Kody cloud.
 */
export async function routePublishBuild(input: {
	env: Env
	request: RequestContext
	apiUrl: string
	context: string | null
	source: EcpPublishBuildSource
	limits: { timeoutMs: number; memoryMb: number }
	fallbackToCloud?: boolean
	signal?: AbortSignal
}): Promise<
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
	if (!request.actor) {
		throw new ExecutionContextError({
			status: 401,
			code: 'insufficient_scope',
			message: 'Building on an execution context needs a signed-in person.',
		})
	}
	if (request.credential.kind === 'execution-context-run') {
		throw new ExecutionContextError({
			status: 403,
			code: 'insufficient_scope',
			message:
				'A context run cannot start a publish build. Run `kody package publish --build context` from your own machine.',
		})
	}
	const outcome = await routeExecute({
		env: input.env,
		request: {
			userId: request.actor.userId,
			handle: request.actor.username ?? null,
			orgId: request.org.id,
			orgSlug: request.org.slug ?? null,
			scopes: (request.credential.scopes as Array<string> | null) ?? null,
			credentialKind: request.credential.kind,
			profileAccess: request.credential.profileId
				? await computeEffectivePermissions({ env: input.env, request })
				: null,
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
		...(input.signal ? { signal: input.signal } : {}),
		publishBuild: { source: input.source, limits: input.limits },
	})
	if (outcome.kind === 'cloud' && input.fallbackToCloud) {
		return { kind: 'cloud' }
	}
	if (outcome.kind === 'cloud' || outcome.kind === 'queued') {
		throw new ExecutionContextError({
			status: 409,
			code: 'execution_context_unavailable',
			message:
				'No execution context you operate could take this publish build. Start one with `kody context start`, or build on this machine with `kody package publish --build local`.',
		})
	}
	if (outcome.kind === 'pending') {
		throw new ExecutionContextError({
			status: 504,
			code: 'execution_context_unavailable',
			message: `The publish build on ${outcome.metadata.name} did not finish in time.`,
		})
	}
	return {
		kind: 'context',
		result: outcome.result,
		contextName: outcome.metadata.name ?? 'an execution context',
	}
}
