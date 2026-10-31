/**
 * Where an automation run (job, webhook, subscription, workflow step) goes:
 * the same `context` / `chain` / `fallback` / `requires` rules as execute,
 * plus `whenOffline` for what happens when the target is not connected.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import {
	type AutomationExecution,
	automationQueueExpiresAt,
} from './automation-execution-schema.ts'
import { ExecutionContextError } from './errors.ts'
import { isExecutionContextsEnabledFor } from './flag.ts'
import { type ExecutionContextRunMetadata, routeExecute } from './routing.ts'
import { resolveRunCredentialUse } from './run-credential-use.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'

export type AutomationRouting = {
	setting: AutomationExecution
	/** Module the context runs: imports the package export and calls it. */
	contextCode: string | null
	/**
	 * The automation's own run when its caller owns that record (keyed
	 * invocations). The context run gets a child record under it.
	 */
	parentRunRecord?: RunRecordContext | null
	parentRunId?: string | null
	/** Workflow steps: a handed-off (still running) context run fails the step. */
	needsResult?: boolean
}

/**
 * Routes one automation run. The run acts as the request's actor: for a
 * trigger that is the enabler, the same person billed for the run
 * (`backgroundRunBilledActor`), so every hop re-checks that person's
 * access. Null means run on Kody cloud.
 */
export async function routeAutomationRun(input: {
	env: Env
	callerContext: McpCallerContext
	routing: AutomationRouting
	runRecord: RunRecordHandle | null
	params: unknown
	waitMs: number
	signal?: AbortSignal
}) {
	const request = input.callerContext.request
	const actor = request?.actor ?? null
	if (!request || !actor || !input.runRecord) {
		throw new ExecutionContextError({
			status: 409,
			code: 'no_execution_context_available',
			message:
				'This automation asks for an execution context, but it has no person to act as (enable it first), so it did not run.',
		})
	}
	const enabled = await isExecutionContextsEnabledFor(
		input.env.APP_DB,
		actor.userId,
		request.org.id,
	)
	if (!enabled) {
		throw new ExecutionContextError({
			status: 403,
			code: 'feature_disabled',
			message:
				'This automation asks for an execution context, but the execution-contexts feature flag is off for the person it runs as, so it did not run. Remove its execution setting to run on Kody cloud.',
		})
	}
	const { setting } = input.routing
	if (input.routing.contextCode === null) {
		throw new ExecutionContextError({
			status: 409,
			code: 'invalid_request',
			message:
				'This automation asks for an execution context, but its handler is not a package export, so a context cannot import it and it did not run. Export the handler from the package, or remove its execution setting.',
		})
	}
	return await routeExecute({
		env: input.env,
		request: {
			userId: actor.userId,
			handle: actor.username ?? null,
			orgId: request.org.id,
			orgSlug: request.org.slug ?? null,
			scopes: (request.credential.scopes as Array<string> | null) ?? null,
			credentialKind: request.credential.kind,
			profileAccess: request.credential.profileId
				? await computeEffectivePermissions({ env: input.env, request })
				: null,
			profileId: request.credential.profileId ?? null,
		},
		args: {
			...(setting.context ? { context: setting.context } : {}),
			...(setting.fallback ? { fallback: setting.fallback } : {}),
			...(setting.chain ? { chain: setting.chain } : {}),
			...(setting.requires ? { requires: setting.requires } : {}),
		},
		runId: input.runRecord.id,
		runRecord: input.runRecord,
		code: input.routing.contextCode,
		params: input.params,
		credentials: null,
		credentialUse: () =>
			resolveRunCredentialUse({
				env: input.env,
				request,
				ownerId: request.org.id,
				code: input.routing.contextCode,
				credentials: null,
			}),
		apiUrl: input.callerContext.baseUrl,
		waitMs: input.waitMs,
		...(input.signal ? { signal: input.signal } : {}),
		queue:
			setting.whenOffline === 'queue'
				? { expiresAt: automationQueueExpiresAt(setting) }
				: null,
		unknownChainRef: 'skip',
	})
}

/** A context run the automation handed off: it finishes in run history. */
export type ContextRunDeferral = {
	state: 'queued' | 'running'
	runId: string
	context: string
	contextId?: string
	expiresAt?: string
}

/** How long an automation waits on a context run before handing it off. */
export const automationContextWaitMs = 5 * 60_000

/**
 * Runs an automation on its execution context. `cloud` means the hosted
 * sandbox runs it as usual; `done` results already sit in run history.
 */
export async function runAutomationOnContext(input: {
	env: Env
	callerContext: McpCallerContext
	routing: AutomationRouting
	runRecord: RunRecordHandle | null
	params: unknown
	waitMs: number
	signal?: AbortSignal
}): Promise<
	| { kind: 'cloud'; metadata?: ExecutionContextRunMetadata }
	| { kind: 'error'; error: Error }
	| {
			kind: 'done'
			result: { result: unknown; error?: string; logs?: Array<string> }
			deferred?: ContextRunDeferral
	  }
> {
	let routed: Awaited<ReturnType<typeof routeAutomationRun>>
	try {
		routed = await routeAutomationRun(input)
	} catch (error) {
		if (!(error instanceof ExecutionContextError)) throw error
		return {
			kind: 'error',
			error: Object.assign(new Error(automationRoutingMessage(error)), {
				name: 'ExecutionContextRoutingError',
				code: error.code,
			}),
		}
	}
	switch (routed.kind) {
		case 'cloud':
			return routed.metadata
				? { kind: 'cloud', metadata: routed.metadata }
				: { kind: 'cloud' }
		case 'ran': {
			const content = routed.result.structuredContent ?? {}
			const logs = Array.isArray(content.logs)
				? content.logs.filter(
						(line): line is string => typeof line === 'string',
					)
				: []
			if (routed.result.isError) {
				const error =
					typeof content.error === 'string'
						? content.error
						: (firstText(routed.result.content) ??
							`The run on ${routed.metadata.name} failed.`)
				return { kind: 'done', result: { result: undefined, error, logs } }
			}
			return { kind: 'done', result: { result: content.result, logs } }
		}
		case 'pending': {
			const context = routed.metadata.name ?? routed.metadata.id ?? 'context'
			return {
				kind: 'done',
				result: {
					result: {
						status: 'running_on_execution_context',
						runId: routed.runId,
						context,
					},
				},
				deferred: {
					state: 'running',
					runId: routed.runId,
					context,
					...(routed.metadata.id ? { contextId: routed.metadata.id } : {}),
				},
			}
		}
		case 'queued': {
			const expiresAt = new Date(routed.expiresAt).toISOString()
			return {
				kind: 'done',
				result: {
					result: {
						status: 'queued_for_execution_context',
						runId: routed.runId,
						context: routed.contextName,
						expiresAt,
					},
					logs: [
						`${routed.contextName} is offline or busy; this run is queued until it can take it or ${expiresAt}.`,
					],
				},
				deferred: {
					state: 'queued',
					runId: routed.runId,
					context: routed.contextName,
					expiresAt,
				},
			}
		}
	}
}

function automationRoutingMessage(error: ExecutionContextError) {
	return `${error.message} (${error.code})`
}

function firstText(content: Array<unknown>) {
	for (const block of content) {
		if (
			block &&
			typeof block === 'object' &&
			'text' in block &&
			typeof block.text === 'string'
		) {
			return block.text
		}
	}
	return null
}
