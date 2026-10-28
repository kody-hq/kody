/**
 * The `execution` setting automations declare (manifest, API, UI): the same
 * `context` / `chain` / `fallback` / `requires` rules as execute, plus
 * `whenOffline`. Leaf module so the package registry can import it.
 */
import { ecpMaxChainContexts } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { z } from 'zod'
import { executeRequirements, runChainShapeError } from './chain-rules.ts'

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
