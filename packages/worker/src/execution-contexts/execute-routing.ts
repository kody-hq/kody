import { ecpMaxChainContexts } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { z } from 'zod'
import { type CredentialCallMap } from '#worker/credentials/credential-call-map.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { ExecutionContextError } from './errors.ts'
import {
	type ExecuteRoutingArgs,
	executeRequirements,
	routeExecute,
} from './routing.ts'
import { resolveRunCredentialUse } from './run-credential-use.ts'

export { type ExecuteRoutingArgs } from './routing.ts'

export const executeRoutingInputFields = {
	context: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Execution context to run on: its id (ec_...) or name, or "cloud". A named context never falls back unless fallback is "chain". Omit to use your fallback chain.',
		),
	fallback: z
		.enum(['chain'])
		.optional()
		.describe(
			'"chain" lets a named context that cannot take the run fall back to your chain.',
		),
	requires: z
		.array(z.enum(executeRequirements))
		.max(executeRequirements.length)
		.optional()
		.describe(
			'Local access the run needs ("fs", "lan"). Kody cloud is skipped when this is set.',
		),
	chain: z
		.array(z.string().trim().min(1))
		.min(1)
		.max(ecpMaxChainContexts + 1)
		.optional()
		.describe(
			'This run\'s own ordered chain, replacing your default chain: up to 3 context ids or names, with "cloud" allowed only last. Leaving out "cloud" means the run fails instead of falling back to Kody cloud. Entries that are offline, unusable, lack `requires`, are busy (at their concurrent-run limit), or belong to another person when the run can use credentials (a credentials map, a secret or integration placeholder, a kody:runtime credential helper or credentialed call, or any kody: package the code imports, directly or through other packages, that can use one) are skipped before the code starts; if none qualifies the error lists each one and why. On your own contexts a run uses your credentials exactly as in Kody cloud (requests leave from Kody cloud).',
		),
}

function asksForRouting(args: ExecuteRoutingArgs) {
	return Boolean(
		args.context?.trim() ||
		args.fallback ||
		(args.requires?.length ?? 0) > 0 ||
		(args.chain?.length ?? 0) > 0,
	)
}

/**
 * Execute routing for one call. Null keeps today's hosted path untouched:
 * the flag is off (and no routing field was sent), or there is no person
 * or run record to route for.
 */
export async function routeExecuteForCaller(input: {
	env: Env
	callerContext: McpCallerContext
	args: ExecuteRoutingArgs
	enabled: boolean
	runRecord: RunRecordHandle | null
	code: string | null
	params: unknown
	conversationId: string
	credentials: CredentialCallMap | null
	waitMs: number
	signal?: AbortSignal
}) {
	if (!input.enabled) {
		if (asksForRouting(input.args)) {
			throw new ExecutionContextError({
				status: 403,
				code: 'feature_disabled',
				message:
					'context, chain, fallback and requires need the execution-contexts feature flag, which is off for this account. Remove them to run on Kody cloud.',
			})
		}
		return null
	}
	const request = input.callerContext.request
	if (!request?.actor || !input.runRecord) {
		if (asksForRouting(input.args)) {
			throw new ExecutionContextError({
				status: 401,
				code: 'insufficient_scope',
				message: 'Running on an execution context needs a signed-in person.',
			})
		}
		return null
	}
	if (request.credential.kind === 'execution-context-run') {
		// A nested execute from the operator's own context run runs on Kody
		// cloud, so it cannot re-enter the busy context it came from.
		return null
	}
	return routeExecute({
		env: input.env,
		request: {
			userId: request.actor.userId,
			handle: request.actor.username ?? null,
			orgId: request.org.id,
			orgSlug: request.org.slug ?? null,
			scopes: (request.credential.scopes as Array<string> | null) ?? null,
			credentialKind: request.credential.kind,
		},
		args: input.args,
		runId: input.runRecord.id,
		runRecord: input.runRecord,
		code: input.code,
		params: input.params,
		conversationId: input.conversationId,
		credentials: input.credentials,
		credentialUse: () =>
			resolveRunCredentialUse({
				env: input.env,
				request,
				ownerId: request.org.id,
				code: input.code,
				credentials: input.credentials,
			}),
		apiUrl: input.callerContext.baseUrl,
		waitMs: input.waitMs,
		signal: input.signal,
	})
}
