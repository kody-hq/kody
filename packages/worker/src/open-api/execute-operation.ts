import { executeRoutingInputFields } from '#worker/execution-contexts/execute-routing.ts'
import { z } from 'zod'
import { runExecuteToolCall } from '#mcp/tools/execute.ts'
import {
	isWalletGuardLimitErrorDetails,
	WalletGuardLimitError,
} from '#worker/wallet-guard/enforce.ts'
import {
	detachedExecuteWorkLimitMs,
	openApiExecuteTransportBudgetMs,
} from '#mcp/execute-transport-budget.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
} from '#mcp/tools/tool-call-context.ts'
import { credentialCallMapSchema } from '#worker/credentials/credential-call-map.ts'
import { runRecordMaxIdempotencyKeyLength } from '#worker/run-records/types.ts'
import {
	parseNativeInput,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'

const executeCodeFieldDescription =
	'Single ESM module string with a default export. Imports may be npm packages compatible with the Cloudflare Workers runtime.'

export const executeHttpInputSchema = z.object({
	code: z.string().optional().describe(executeCodeFieldDescription),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('JSON object passed to the default export.'),
	responseLimit: z.number().int().min(1).optional(),
	conversationId: conversationIdInputField,
	memoryContext: memoryContextInputField,
	idempotencyKey: z
		.string()
		.min(1)
		.max(runRecordMaxIdempotencyKeyLength)
		.optional(),
	credentials: credentialCallMapSchema.optional(),
	...executeRoutingInputFields,
})

export const executeHttpOutputSchema = z.object({
	content: z.array(z.unknown()),
	structuredContent: z.record(z.string(), z.unknown()),
	isError: z.boolean(),
})

/**
 * Hosted execute over HTTP. Same runner as the MCP `execute` tool.
 * Module failures stay HTTP 200 with `isError: true` (the call itself
 * succeeded). Auth failures are 401/403 before this handler.
 */
export const executeOperationDefinition: NativeApiOperationDefinition = {
	summary: 'Execute a module in the cloud sandbox',
	description:
		"Run one ESM module in Kody's hosted sandbox. Same inputs and result envelope as the MCP `execute` tool (`content`, `structuredContent`, `isError`). Requires `Authorization: Bearer kody_at_…` with `org:execute`. JSON bodies follow the Open API 5 MiB cap. Older CLIs keep using MCP `execute`; this route does not accept MCP OAuth.",
	inputSchema: executeHttpInputSchema,
	outputSchema: executeHttpOutputSchema,
	readOnly: false,
	async handler(params, ctx) {
		const args = parseNativeInput(executeHttpInputSchema, params)
		const startedByLabel =
			ctx.principal.kind === 'token' ? ctx.principal.token.name : null
		const result = await runExecuteToolCall({
			env: ctx.env,
			callerContext: ctx.callerContext,
			loopbackExports: ctx.loopbackExports ?? ({} as Cloudflare.Exports),
			waitUntil: ctx.waitUntil,
			args,
			startedByLabel,
			transportBudgetMs: openApiExecuteTransportBudgetMs,
			detachedWorkLimitMs: detachedExecuteWorkLimitMs,
		})
		// A denial-of-wallet ceiling refused the call before any module ran,
		// so it is a 429 with Retry-After, not a module failure.
		const rateLimit = (
			result.structuredContent as { rateLimit?: unknown } | undefined
		)?.rateLimit
		if (result.isError && isWalletGuardLimitErrorDetails(rateLimit)) {
			throw new WalletGuardLimitError(rateLimit)
		}
		return result
	},
}
