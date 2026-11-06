import { z } from 'zod'
import { localReadCommands } from '#worker/credentials/local-read-store.ts'
import {
	maxLocalReadNames,
	readSecretsLocally,
} from '#worker/credentials/local-read.ts'
import { ApiError, invalidRequest } from './errors.ts'
import {
	parseNativeInput,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'

const inputSchema = z
	.object({
		names: z
			.array(z.string().trim().min(1).max(600))
			.min(1)
			.max(maxLocalReadNames)
			.describe(
				'Secret names, or `secret/<provider>:<ref>` for a provider-backed secret.',
			),
		command: z
			.enum(localReadCommands)
			.describe('The CLI command reading: `run` or `get`.'),
	})
	.strict()

const outputSchema = z.object({
	secrets: z.array(z.object({ name: z.string(), value: z.string() })),
})

/**
 * `kody secret get` and `kody run` only (ADR 0096). HTTP with a `kody_at_`
 * token; the MCP `api` tool, CLI OAuth, and execution-context runs are
 * refused so a value never reaches an agent chat or a shared machine.
 */
export const secretLocalReadDefinition: NativeApiOperationDefinition = {
	summary: 'Read secrets locally with the Kody CLI',
	description:
		'For `kody secret get` and `kody run` only, never the MCP `api` tool. Returns the values of secrets whose local reads a person turned on, all or nothing. Interactive `kody login` tokens can read; agent-minted tokens need the `secret:read_local` scope, and a profile needs "read locally" on each secret. Refusals return 403 with a plain-language reason per secret and a link to turn on local reads.',
	inputSchema,
	outputSchema,
	readOnly: true,
	async handler(params, ctx) {
		if (ctx.principal.kind !== 'token') {
			throw invalidRequest(
				'Local secret reads are only for the Kody CLI (`kody secret get` and `kody run`) with a kody_at_ token. Agents cannot read secret values through MCP.',
			)
		}
		const request = ctx.callerContext.request
		if (!request) throw invalidRequest('An org request is required.')
		const input = parseNativeInput(inputSchema, params)
		const result = await readSecretsLocally({
			env: ctx.env,
			baseUrl: ctx.callerContext.baseUrl,
			request,
			token: ctx.principal.token,
			names: input.names,
			command: input.command,
			ip: ctx.clientIp ?? null,
		})
		if (!result.ok) {
			const rateLimited = result.refusals.some(
				(refusal) => refusal.reason === 'rate_limited',
			)
			throw new ApiError({
				status: rateLimited ? 429 : 403,
				code: rateLimited ? 'rate_limited' : 'insufficient_scope',
				message: result.refusals.map((refusal) => refusal.message).join(' '),
				details: { refusals: result.refusals },
				...(rateLimited ? { headers: { 'Retry-After': '60' } } : {}),
			})
		}
		return { secrets: result.values }
	},
}
