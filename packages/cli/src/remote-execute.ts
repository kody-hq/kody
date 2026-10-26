import { assertTokenSafeApiUrl } from './capability-proxy.js'
import { openApiRequest } from './open-api-client.js'
import { type CredentialCallMapInput } from './credential-call-map.js'
import { type ToolCallResult } from './tool-result.js'
import { resolveExecuteInvokeCode } from './invoke-passthrough.js'

export type RemoteExecuteInput = {
	code?: string
	invoke?: string
	params?: unknown
	conversationId?: string
	/**
	 * Not supported on CapabilityProxy → `kody.execute` (the package-callable
	 * capability omits the map on purpose). Prefer `--local` or MCP execute.
	 */
	credentials?: CredentialCallMapInput
	token: string
	apiUrl: string
	fetchFn?: typeof fetch
	/** User-owned token org selection (`?org=`). */
	org?: string
}

/**
 * Cloud (non-`--local`) execute authenticated only with a scoped API token:
 * CapabilityProxy session + `kody.execute`. The module runs in Kody's cloud
 * sandbox; no `kody login` and no local workerd.
 *
 * Requires the `local-execute` feature flag and token scope (same as
 * `execute --local`).
 */
export async function runRemoteExecuteWithToken(
	input: RemoteExecuteInput,
): Promise<ToolCallResult> {
	assertTokenSafeApiUrl(input.apiUrl)
	const invoke = input.invoke?.trim()
	const body: Record<string, unknown> = {}
	if (invoke && input.code?.trim()) {
		throw new Error(
			'--invoke cannot be combined with --code, --file, or a module string.',
		)
	}
	// Cloud Open API execute still gates the `invoke` field on the
	// execute-invoke experiment. Mint the same thin passthrough as `code` so
	// `kody execute --invoke` keeps working for callers without that flag.
	// When execute-invoke is generally available, prefer body.invoke here so
	// Activity can attribute invoke vs handwritten code.
	body.code = resolveRemoteExecuteCode(input)
	if (input.params !== undefined) body.params = input.params
	if (input.conversationId !== undefined)
		body.conversationId = input.conversationId
	if (input.credentials !== undefined) body.credentials = input.credentials
	const payload = await openApiRequest({
		token: input.token,
		apiUrl: input.apiUrl,
		fetchFn: input.fetchFn,
		...(input.org ? { org: input.org } : {}),
		method: 'POST',
		path: 'v1/execute',
		body,
	})
	return toolResultFromExecuteBody(payload)
}

function toolResultFromExecuteBody(payload: unknown): ToolCallResult {
	if (
		payload &&
		typeof payload === 'object' &&
		!Array.isArray(payload) &&
		'content' in payload &&
		Array.isArray((payload as { content: unknown }).content)
	) {
		const record = payload as {
			content: ToolCallResult['content']
			structuredContent?: ToolCallResult['structuredContent']
			isError?: boolean
		}
		return {
			content: record.content,
			structuredContent: record.structuredContent,
			isError: record.isError === true,
		}
	}
	return formatExecuteCapabilityResult(payload)
}

export function resolveRemoteExecuteCode(input: {
	code?: string
	invoke?: string
}): string {
	const code = input.code?.trim() ? input.code : undefined
	const invoke = input.invoke?.trim() ? input.invoke : undefined
	if (code && invoke) {
		throw new Error(
			'--invoke cannot be combined with --code, --file, or a module string.',
		)
	}
	if (invoke) return resolveExecuteInvokeCode(invoke)
	if (code) return code
	throw new Error('Provide --invoke, --code, --file, or a module string.')
}

/**
 * Map `kody.execute` capability output (returned as CapabilityProxy `result`)
 * into the same ToolCallResult envelope MCP execute / local execute use.
 */
export function formatExecuteCapabilityResult(
	payload: unknown,
): ToolCallResult {
	const record = isRecord(payload) ? payload : null
	if (!record) {
		const text =
			typeof payload === 'string'
				? payload
				: (JSON.stringify(payload, null, 2) ?? 'undefined')
		return {
			content: [{ type: 'text', text }],
			structuredContent: { result: payload },
			isError: false,
		}
	}

	const ok = record.ok !== false && typeof record.error !== 'string'
	const conversationId =
		typeof record.conversationId === 'string'
			? record.conversationId
			: undefined
	const logs = Array.isArray(record.logs) ? record.logs : []
	const base: Record<string, unknown> = {
		...(conversationId !== undefined ? { conversationId } : {}),
		logs,
	}
	for (const key of [
		'timing',
		'runId',
		'replayed',
		'inProgress',
		'status',
		'returnedBytes',
		'truncated',
		'note',
		'errorDetails',
		'entitlement',
		'serverTiming',
	] as const) {
		if (record[key] !== undefined) base[key] = record[key]
	}

	if (!ok) {
		const error =
			typeof record.error === 'string'
				? record.error
				: 'Execute failed without an error message.'
		return {
			content: [{ type: 'text', text: `Error: ${error}` }],
			structuredContent: { ...base, error, result: record.result },
			isError: true,
		}
	}

	const result = record.result
	const text =
		typeof result === 'string'
			? result
			: (JSON.stringify(result, null, 2) ?? 'undefined')
	return {
		content: [{ type: 'text', text }],
		structuredContent: { ...base, result },
		isError: false,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
