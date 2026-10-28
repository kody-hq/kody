/**
 * Where an automation run (job, webhook, subscription, workflow step) goes:
 * the same `context` / `chain` / `fallback` / `requires` rules as execute,
 * plus `whenOffline` for what happens when the target is not connected.
 */
import { ecpMaxChainContexts } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { z } from 'zod'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { runChainShapeError } from './chain-rules.ts'
import { ExecutionContextError } from './errors.ts'
import { isExecutionContextsEnabledFor } from './flag.ts'
import { executeRequirements, routeExecute } from './routing.ts'

export const automationQueueDefaultMinutes = 60
export const automationQueueMaxMinutes = 24 * 60

export const automationExecutionSchema = z
	.strictObject({
		context: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(
				'Execution context to run on: its name or id (ec_...), or "cloud". Never falls back unless fallback is "chain".',
			),
		fallback: z
			.enum(['chain'])
			.optional()
			.describe(
				'"chain" lets a named context that cannot take the run fall back to the chain.',
			),
		chain: z
			.array(z.string().trim().min(1))
			.min(1)
			.max(ecpMaxChainContexts + 1)
			.optional()
			.describe(
				'This automation\'s own ordered chain, replacing the default chain: up to 3 context names or ids, with "cloud" allowed only last.',
			),
		requires: z
			.array(z.enum(executeRequirements))
			.max(executeRequirements.length)
			.optional()
			.describe('Local access the run needs ("fs", "lan"). Skips Kody cloud.'),
		whenOffline: z
			.enum(['fail', 'queue'])
			.optional()
			.describe(
				'"fail" (default) fails the run when no context can take it. "queue" waits for the first offline context to reconnect, up to queueMinutes.',
			),
		queueMinutes: z
			.number()
			.int()
			.min(1)
			.max(automationQueueMaxMinutes)
			.optional()
			.describe(
				`How long a queued run waits for its context (default ${automationQueueDefaultMinutes}, max ${automationQueueMaxMinutes}).`,
			),
	})
	.superRefine((value, ctx) => {
		if (!value.context && !value.chain && !value.requires?.length) {
			ctx.addIssue({
				code: 'custom',
				message: 'execution needs context, chain, or requires.',
			})
		}
		if (value.fallback && !value.context) {
			ctx.addIssue({
				code: 'custom',
				path: ['fallback'],
				message: 'fallback applies only with context.',
			})
		}
		if (value.queueMinutes !== undefined && value.whenOffline !== 'queue') {
			ctx.addIssue({
				code: 'custom',
				path: ['queueMinutes'],
				message: 'queueMinutes applies only with whenOffline: "queue".',
			})
		}
		if (value.chain) {
			const shape = runChainShapeError(value.chain)
			if (shape) {
				ctx.addIssue({
					code: 'custom',
					path: ['chain'],
					message: shape.message,
				})
			}
		}
	})

export type AutomationExecution = z.infer<typeof automationExecutionSchema>

/** Parses a stored setting; anything unreadable is treated as unset. */
export function parseAutomationExecution(
	value: unknown,
): AutomationExecution | null {
	if (value == null) return null
	const raw = typeof value === 'string' ? safeJson(value) : value
	const parsed = automationExecutionSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

export function automationQueueExpiresAt(
	setting: AutomationExecution,
	now = Date.now(),
) {
	return now + (setting.queueMinutes ?? automationQueueDefaultMinutes) * 60_000
}

export type AutomationRouting = {
	setting: AutomationExecution
	/** Module the context runs: imports the package export and calls it. */
	contextCode: string | null
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
	return await routeExecute({
		env: input.env,
		request: {
			userId: actor.userId,
			handle: actor.username ?? null,
			orgId: request.org.id,
			orgSlug: request.org.slug ?? null,
			scopes: null,
			credentialKind: request.credential.kind,
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
