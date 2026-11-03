import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { redactKodyCredentials } from '@kody-internal/shared/api-token-format.ts'
import {
	defaultExecutionResponseLimitBytes,
	formatLimitedExecutionOutput,
	limitExecutionResultValue,
} from '#mcp/executor.ts'
import { preferLocalCliExecuteGuidance } from '#mcp/instructions/prefer-local-cli-execute-guidance.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { callerContextFields, logMcpEvent } from '#mcp/observability.ts'
import { createApiInvocationContext } from '#worker/open-api/context.ts'
import { ApiError, toApiError } from '#worker/open-api/errors.ts'
import type * as OpenApiInvoke from '#worker/open-api/invoke.ts'
import { type StructuredContentFromFields } from './mcp-tool-output.ts'
import { buildKodyToolIcons } from './tool-icons.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'

let openApiInvokeMemo: Promise<typeof OpenApiInvoke> | null = null

// The operation catalog builds zod schemas at module scope; load it on the
// first api call instead of during platform startup (see startup-budget.md).
function loadOpenApiInvoke() {
	openApiInvokeMemo ??= import('#worker/open-api/invoke.ts').catch(
		(error: unknown) => {
			openApiInvokeMemo = null
			throw error
		},
	)
	return openApiInvokeMemo
}

export const apiToolDescription = [
	'Call one Kody API operation directly: no sandbox, no execute quota. Same operations as the HTTP API at https://api.kody.codes/openapi.json.',
	'',
	'- `operationId`: an Open API operation id from https://api.kody.codes/openapi.json (for example `packageList`, `secretSet`, `jobRunNow`, or token ops `tokenCreate` / `tokenList` / `tokenGet` / `tokenRotate` / `tokenRevoke`). Many match `search` capability names, but not every search capability is on the Open API — capability detail says when a capability is execute-only (for example `webhookSyntheticDispatch` and admin capabilities).',
	'- `params`: the operation input as one flat object (the same fields `search` shows for the capability; HTTP path, query, and body fields together).',
	'',
	'Use `execute` instead when you need to compose several calls, transform results, fetch external URLs, or call an execute-only capability.',
	'',
	preferLocalCliExecuteGuidance,
	'Agents already on this MCP session: call `cliCredentialBootstrap` with `lifetime: "short"` (single-task) or `"long"` (returns a one-shot `kody_bc_…` code + `cli_command` that includes lifetime flags, never a `kody_at_…`), run that CLI command, then `npx @kodycodes/cli execute --local --code \'…\'` — no second interactive OAuth and no `tokenCreate`. Interactive humans: `kody login` then `--local`. Mint `tokenCreate` only for CI/headless without an MCP session (include a required lifetime; set `KODY_API_TOKEN` in the environment, never paste into chat). If `--local` cannot run, use Open API / MCP `api` or fix the environment. See https://kody.codes/docs/local-execute and https://kody.codes/docs/open-api.',
].join('\n')

export const apiToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} satisfies ToolAnnotations

/**
 * Advertised MCP output schema for the api tool's `structuredContent`
 * envelope. Single source of truth for tools/list JSON Schema and
 * {@link ApiToolStructuredContent} — keep every emitted top-level key here.
 */
export const apiToolOutputSchema = {
	operationId: z.string().describe('The operation that ran.'),
	result: z
		.unknown()
		.optional()
		.describe('Operation result (JSON) when the call succeeded.'),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			details: z.unknown().optional(),
		})
		.optional()
		.describe('Error envelope when the call failed (isError is set).'),
	truncated: z
		.boolean()
		.optional()
		.describe('True when the result was truncated to fit the response limit.'),
	note: z.string().optional().describe('Explains a truncated result.'),
}

export type ApiToolStructuredContent = StructuredContentFromFields<
	typeof apiToolOutputSchema
>

/** Register the MCP `api` tool for signed-in callers. */
export async function registerApiTool(agent: McpRegistrationAgent) {
	const env = agent.getEnv()
	const icons = buildKodyToolIcons(agent.getCallerContext().baseUrl)
	agent.server.registerTool(
		'api',
		{
			title: 'Kody API',
			description: apiToolDescription,
			inputSchema: {
				operationId: z
					.string()
					.min(1)
					.describe(
						'Operation id: a Kody capability name or a token operation such as tokenCreate.',
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Operation input as one flat JSON object.'),
			},
			outputSchema: apiToolOutputSchema,
			annotations: apiToolAnnotations,
			...(icons ? { icons } : {}),
		},
		async ({
			operationId,
			params,
		}: {
			operationId: string
			params?: Record<string, unknown>
		}) => {
			const timingStart = startToolTiming()
			const callerContext = agent.getCallerContext()
			const fields = callerContextFields(callerContext)
			const logFields = {
				category: 'mcp' as const,
				tool: 'api' as const,
				toolName: 'api',
				capabilityName: operationId,
				baseUrl: fields.baseUrl,
				hasUser: fields.hasUser,
				...(fields.userId ? { userId: fields.userId } : {}),
			}
			try {
				const user = callerContext.user
				if (!user) {
					throw new ApiError({
						status: 401,
						code: 'unauthorized',
						message: 'The api tool requires a signed-in Kody user.',
					})
				}
				const { invokeApiOperation } = await loadOpenApiInvoke()
				const result = await invokeApiOperation({
					operationId,
					params: params ?? {},
					ctx: createApiInvocationContext({
						env,
						callerContext: { ...callerContext, user },
						principal: { kind: 'mcp' },
						...(agent.waitUntil
							? { waitUntil: agent.waitUntil.bind(agent) }
							: {}),
					}),
				})
				const limited = limitExecutionResultValue(
					result ?? null,
					defaultExecutionResponseLimitBytes,
				)
				logMcpEvent({
					...logFields,
					outcome: 'success',
					durationMs: finishToolTiming(timingStart).durationMs,
				})
				return {
					content: [
						{
							type: 'text' as const,
							text: formatLimitedExecutionOutput(limited),
						},
					],
					structuredContent: {
						operationId,
						result: limited.value,
						...(limited.truncated
							? { truncated: true, note: limited.note }
							: {}),
					},
				}
			} catch (error) {
				const apiError = toApiError(error, { operation: 'mcp_api' })
				logMcpEvent({
					...logFields,
					outcome: 'failure',
					durationMs: finishToolTiming(timingStart).durationMs,
					failurePhase: 'handler',
					errorName: apiError.code,
					errorMessage: redactKodyCredentials(apiError.message),
					callerError: apiError.status < 500,
					cause: error,
				})
				const body = apiError.toBody()
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Error (${body.error.code}): ${body.error.message}${
								body.error.details === undefined
									? ''
									: `\n\n${JSON.stringify(body.error.details, null, 2)}`
							}`,
						},
					],
					structuredContent: { operationId, error: body.error },
				}
			}
		},
	)
}
