import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from './maintenance-handler.ts'
import { handleMcpRequest, mcpResourcePath } from './mcp-auth.ts'
import { mediaType } from '@kody-internal/shared/media-type.ts'

export const executeHealthMaintenancePath = '/__maintenance/mcp-execute-health'
export const executeHealthProbeCode = 'export default async () => 1'
export const executeHealthProbeClientName = 'kody-execute-health'
export const executeHealthProbeScope = 'authenticated-mcp-execute' as const
export const executeHealthProbeProves = 'platform-mcp-execute' as const
export const executeHealthProbeExpectedResult = 1

type LegacyMcpFetch = Parameters<typeof handleMcpRequest>[0]['fetchMcp']

export type ExecuteHealthProbeCallMcp = (request: Request) => Promise<Response>

export async function runAuthenticatedMcpExecuteHealthProbe(input: {
	token: string
	mcpOrigin: string
	callMcp: ExecuteHealthProbeCallMcp
}): Promise<{
	result: unknown
	scope: typeof executeHealthProbeScope
	proves: typeof executeHealthProbeProves
}> {
	const token = input.token.trim()
	if (!token) {
		throw new MaintenanceFailureError(
			'Execute health canary is not configured',
			{ reason: 'not-configured' },
		)
	}
	const mcpUrl = `${input.mcpOrigin}${mcpResourcePath}`
	const initialize = await input.callMcp(
		mcpJsonRpcRequest({
			url: mcpUrl,
			token,
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: {
					name: executeHealthProbeClientName,
					version: '1.0.0',
				},
			},
		}),
	)
	await assertMcpOk(initialize, 'initialize')
	const sessionId = initialize.headers.get('mcp-session-id')
	if (!sessionId) {
		throw new MaintenanceFailureError(
			'Authenticated MCP execute probe did not receive a session',
			{ reason: 'missing-session' },
		)
	}

	const initialized = await input.callMcp(
		mcpJsonRpcRequest({
			url: mcpUrl,
			token,
			sessionId,
			method: 'notifications/initialized',
			params: {},
		}),
	)
	if (!initialized.ok) {
		throw new MaintenanceFailureError(
			`Authenticated MCP execute probe initialized notification failed: HTTP ${String(initialized.status)}`,
			{ reason: 'initialized-failed' },
		)
	}

	const call = await input.callMcp(
		mcpJsonRpcRequest({
			url: mcpUrl,
			token,
			sessionId,
			id: 2,
			method: 'tools/call',
			params: {
				name: 'execute',
				arguments: {
					code: executeHealthProbeCode,
				},
			},
		}),
	)
	const body = await assertMcpOk(call, 'tools/call')
	const result = readExecuteToolResult(body)
	if (result.isError) {
		throw new MaintenanceFailureError(
			'Authenticated MCP execute probe returned an execute error',
			{ reason: 'execute-error' },
		)
	}
	if (result.value !== executeHealthProbeExpectedResult) {
		throw new MaintenanceFailureError(
			'Authenticated MCP execute probe returned an unexpected result',
			{ reason: 'unexpected-result' },
		)
	}
	return {
		result: result.value,
		scope: executeHealthProbeScope,
		proves: executeHealthProbeProves,
	}
}

export async function handleExecuteHealthProbeRequest(
	request: Request,
	env: {
		APP_BASE_URL?: string
		STATUS_INCIDENT_EVENT_SECRET?: string
		MCP_EXECUTE_HEALTH_CANARY_ACCESS_TOKEN?: string
	},
	ctx: ExecutionContext,
	fetchMcp?: LegacyMcpFetch,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.STATUS_INCIDENT_EVENT_SECRET,
		notConfiguredMessage: 'MCP execute health probe is not configured',
		run: async () => {
			const token = env.MCP_EXECUTE_HEALTH_CANARY_ACCESS_TOKEN?.trim() ?? ''
			const mcpOrigin = getAppBaseUrl({ env, requestUrl: request.url })
			const resolvedFetchMcp = fetchMcp ?? (await loadLegacyMcpFetch())
			return await runAuthenticatedMcpExecuteHealthProbe({
				token,
				mcpOrigin,
				callMcp: (mcpRequest) =>
					handleMcpRequest({
						request: mcpRequest,
						env: env as Env,
						ctx,
						fetchMcp: resolvedFetchMcp,
					}),
			})
		},
	})
}

let legacyMcpFetchMemo: Promise<LegacyMcpFetch> | null = null

function loadLegacyMcpFetch(): Promise<LegacyMcpFetch> {
	legacyMcpFetchMemo ??= import('./mcp/index.ts')
		.then(
			({ MCP }) =>
				MCP.serve(mcpResourcePath, { binding: 'MCP_OBJECT' })
					.fetch as LegacyMcpFetch,
		)
		.catch((error: unknown) => {
			legacyMcpFetchMemo = null
			throw error
		})
	return legacyMcpFetchMemo
}

function mcpJsonRpcRequest(input: {
	url: string
	token: string
	sessionId?: string
	id?: number
	method: string
	params: Record<string, unknown>
}): Request {
	const headers = new Headers({
		Authorization: `Bearer ${input.token}`,
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
	})
	if (input.sessionId) headers.set('Mcp-Session-Id', input.sessionId)
	const body: Record<string, unknown> = {
		jsonrpc: '2.0',
		method: input.method,
		params: input.params,
	}
	if (input.id !== undefined) body['id'] = input.id
	return new Request(input.url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	})
}

async function assertMcpOk(response: Response, step: string) {
	if (!response.ok) {
		throw new MaintenanceFailureError(
			`Authenticated MCP execute probe ${step} failed: HTTP ${String(response.status)}`,
			{ reason: 'http-error', status: response.status },
		)
	}
	const body = await readMcpJsonRpcBody(response)
	if (isRecord(body) && body['error']) {
		throw new MaintenanceFailureError(
			`Authenticated MCP execute probe ${step} returned a JSON-RPC error`,
			{ reason: 'jsonrpc-error' },
		)
	}
	return body
}

async function readMcpJsonRpcBody(response: Response): Promise<unknown> {
	const contentType = mediaType(response.headers.get('content-type'))
	const text = await response.text()
	if (!text.trim()) return null
	if (contentType === 'text/event-stream') {
		const dataLines = text
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice('data:'.length).trim())
			.filter((line) => line.length > 0 && line !== '[DONE]')
		const last = dataLines.at(-1)
		if (!last) return null
		return JSON.parse(last) as unknown
	}
	return JSON.parse(text) as unknown
}

function readExecuteToolResult(body: unknown): {
	value: unknown
	isError: boolean
} {
	const result = isRecord(body) ? body['result'] : null
	if (!isRecord(result)) {
		throw new MaintenanceFailureError(
			'Authenticated MCP execute probe returned an empty execute result',
			{ reason: 'empty-result' },
		)
	}
	const structured = isRecord(result['structuredContent'])
		? result['structuredContent']
		: null
	return {
		value: structured?.['result'],
		isError: result['isError'] === true,
	}
}
