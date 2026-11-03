import type {
	McpOAuthSettlePhase,
	McpServerConnectionState,
	McpServerLastError,
} from './types.ts'

export type { McpOAuthSettlePhase, McpServerLastError }

const httpStatusPattern =
	/\b(?:HTTP(?:\s+status(?:\s+code)?)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i
const httpStatusWordPattern =
	/\b(\d{3})\s+(?:Forbidden|Unauthorized|Not Found|Bad Request|Internal Server Error|Too Many Requests|Service Unavailable)\b/i
const bearerPattern = /\bBearer\s+\S+/gi
const secretFieldNames =
	'access_token|refresh_token|id_token|client_secret|authorization|password|secret|api[_-]?key|code'
const jsonQuotedSecretPattern = new RegExp(
	`"(${secretFieldNames})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`,
	'gi',
)
const assignmentSecretPattern = new RegExp(
	`\\b(?:${secretFieldNames})\\s*[:=]\\s*\\S+`,
	'gi',
)
const jwtLikePattern =
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g

export const mcpServerLastErrorBodySnippetLimit = 160

export function sanitizePublicUrl(
	value: string | null | undefined,
): string | null {
	if (!value) return null
	try {
		const url = new URL(value)
		url.username = ''
		url.password = ''
		url.search = ''
		url.hash = ''
		return url.href
	} catch {
		return null
	}
}

export function sanitizeMcpErrorSnippet(
	value: string | null | undefined,
	limit = mcpServerLastErrorBodySnippetLimit,
): string | null {
	if (!value) return null
	jsonQuotedSecretPattern.lastIndex = 0
	assignmentSecretPattern.lastIndex = 0
	bearerPattern.lastIndex = 0
	const redacted = value
		.replaceAll(bearerPattern, 'Bearer [redacted]')
		.replaceAll(jsonQuotedSecretPattern, '"$1":"[redacted]"')
		.replaceAll(assignmentSecretPattern, (match) => {
			const separator = match.includes('=') ? '=' : ':'
			const key = match.split(/[:=]/)[0]?.trim() ?? 'secret'
			return `${key}${separator}[redacted]`
		})
		.replaceAll(jwtLikePattern, '[redacted]')
		.replaceAll(/\s+/g, ' ')
		.trim()
	if (!redacted) return null
	if (redacted.length <= limit) return redacted
	return `${redacted.slice(0, limit)}…`
}

export function parseHttpStatusFromMcpError(
	value: string | null | undefined,
): number | null {
	if (!value) return null
	const labeled = value.match(httpStatusPattern)
	const word = labeled ?? value.match(httpStatusWordPattern)
	if (!word?.[1]) return null
	const status = Number(word[1])
	return status >= 100 && status <= 599 ? status : null
}

export function inferMcpOAuthSettlePhase(input: {
	state: McpServerConnectionState
	error?: string | null
}): McpOAuthSettlePhase | null {
	const error = input.error?.toLowerCase() ?? ''
	if (
		error.includes('resource metadata') ||
		error.includes('oauth-protected-resource') ||
		error.includes('protected resource')
	) {
		return 'resource metadata'
	}
	if (
		error.includes('token exchange') ||
		error.includes('invalid_grant') ||
		error.includes('unauthorized_client')
	) {
		return 'token exchange'
	}
	if (
		error.includes('initialize') ||
		error.includes('unsupportedprotocolversion') ||
		error.includes('-32022')
	) {
		return 'mcp initialize'
	}
	if (error.includes('tools/list')) return 'tools/list'
	if (error.includes('server/discover') || error.includes('discover')) {
		return 'server/discover'
	}

	switch (input.state) {
		case 'authenticating':
			return 'token exchange'
		case 'connecting':
			return 'mcp initialize'
		case 'connected':
			return 'server/discover'
		case 'discovering':
			return 'tools/list'
		case 'failed':
		case 'disconnected':
		case 'ready':
			return null
		default: {
			const exhaustive: never = input.state
			throw new Error(`Unhandled MCP connection state: ${String(exhaustive)}`)
		}
	}
}

const settleAttemptIdPattern =
	/\bid\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i

export function isFormattedMcpOAuthSettleMessage(
	value: string | null | undefined,
): boolean {
	if (!value) return false
	return (
		/authorization completed/i.test(value) &&
		/\bphase\s/.test(value) &&
		/\bid\s/.test(value)
	)
}

export function readAttemptIdFromSettleMessage(
	value: string | null | undefined,
): string | null {
	if (!value) return null
	return value.match(settleAttemptIdPattern)?.[1] ?? null
}

function rawMcpSettleError(
	value: string | null | undefined,
): string | null | undefined {
	return isFormattedMcpOAuthSettleMessage(value) ? null : value
}

export function formatMcpOAuthSettleErrorMessage(input: {
	state: McpServerConnectionState
	authUrl: string | null
	error?: string | null
	phase?: McpOAuthSettlePhase | null
	httpStatus?: number | null
	httpBodySnippet?: string | null
	mcpEndpoint?: string | null
	resource?: string | null
	authServer?: string | null
	attemptId?: string | null
}): string {
	const error = rawMcpSettleError(input.error)
	const phase =
		input.phase ??
		inferMcpOAuthSettlePhase({
			state: input.state,
			error,
		})
	const details = formatMcpOAuthSettleDetails({
		phase,
		httpStatus: input.httpStatus ?? parseHttpStatusFromMcpError(error),
		httpBodySnippet: sanitizeMcpErrorSnippet(input.httpBodySnippet),
		mcpEndpoint: sanitizePublicUrl(input.mcpEndpoint),
		resource: sanitizePublicUrl(input.resource),
		authServer: sanitizePublicUrl(input.authServer),
		attemptId: input.attemptId?.trim() || null,
	})
	const lead = describeIncompleteMcpOAuthLead({
		state: input.state,
		authUrl: input.authUrl,
		error: sanitizeMcpErrorSnippet(error, 240),
		phase,
	})
	const reconnect = reconnectHint(input.state, input.authUrl)
	if (details && reconnect) return `${lead} (${details}). ${reconnect}`
	if (details) return `${lead} (${details}).`
	if (reconnect) return `${lead}. ${reconnect}`
	return `${lead}.`
}

export function isIncompleteDiscoverState(
	state: McpServerConnectionState,
): boolean {
	return state === 'connected' || state === 'discovering'
}

export function buildIncompleteDiscoverLastError(input: {
	state: McpServerConnectionState
	authUrl?: string | null
	error?: string | null
	phase?: McpOAuthSettlePhase | null
	mcpEndpoint?: string | null
	resource?: string | null
	authServer?: string | null
	attemptId?: string | null
}): McpServerLastError | null {
	if (!isIncompleteDiscoverState(input.state)) return null
	return buildMcpServerLastError({
		state: input.state,
		authUrl: input.authUrl ?? null,
		error: input.error,
		phase: input.phase,
		mcpEndpoint: input.mcpEndpoint,
		resource: input.resource,
		authServer: input.authServer,
		attemptId: input.attemptId?.trim() || crypto.randomUUID(),
	})
}

export function buildMcpServerLastError(input: {
	state: McpServerConnectionState
	authUrl: string | null
	error?: string | null
	phase?: McpOAuthSettlePhase | null
	httpStatus?: number | null
	httpBodySnippet?: string | null
	mcpEndpoint?: string | null
	resource?: string | null
	authServer?: string | null
	attemptId: string
	at?: string
}): McpServerLastError {
	const error = rawMcpSettleError(input.error)
	const phase =
		input.phase ??
		inferMcpOAuthSettlePhase({
			state: input.state,
			error,
		})
	const httpStatus = input.httpStatus ?? parseHttpStatusFromMcpError(error)
	const httpBodySnippet = sanitizeMcpErrorSnippet(
		input.httpBodySnippet ??
			(httpStatus && error && !input.httpBodySnippet ? error : null),
	)
	return {
		message: formatMcpOAuthSettleErrorMessage({
			...input,
			error,
			phase,
			httpStatus,
			httpBodySnippet,
		}),
		phase,
		httpStatus,
		httpBodySnippet,
		mcpEndpoint: sanitizePublicUrl(input.mcpEndpoint),
		resource: sanitizePublicUrl(input.resource),
		authServer: sanitizePublicUrl(input.authServer),
		attemptId: input.attemptId,
		at: input.at ?? new Date().toISOString(),
	}
}

export function parseStoredMcpServerLastError(
	value: string | null | undefined,
): McpServerLastError | null {
	if (!value) return null
	const trimmed = value.trim()
	if (!trimmed) return null
	try {
		const parsed: unknown = JSON.parse(trimmed)
		if (!parsed || typeof parsed !== 'object') {
			return lastErrorFromMessage(trimmed)
		}
		const record = parsed as Record<string, unknown>
		const message =
			typeof record['message'] === 'string' ? record['message'].trim() : ''
		if (!message) return lastErrorFromMessage(trimmed)
		return {
			message,
			phase: parseStoredPhase(record['phase']),
			httpStatus:
				typeof record['httpStatus'] === 'number' &&
				Number.isInteger(record['httpStatus'])
					? record['httpStatus']
					: null,
			httpBodySnippet:
				typeof record['httpBodySnippet'] === 'string'
					? sanitizeMcpErrorSnippet(record['httpBodySnippet'])
					: null,
			mcpEndpoint: sanitizePublicUrl(
				typeof record['mcpEndpoint'] === 'string'
					? record['mcpEndpoint']
					: null,
			),
			resource: sanitizePublicUrl(
				typeof record['resource'] === 'string' ? record['resource'] : null,
			),
			authServer: sanitizePublicUrl(
				typeof record['authServer'] === 'string' ? record['authServer'] : null,
			),
			attemptId:
				typeof record['attemptId'] === 'string' && record['attemptId'].trim()
					? record['attemptId'].trim()
					: 'unknown',
			at:
				typeof record['at'] === 'string' && record['at'].trim()
					? record['at'].trim()
					: new Date(0).toISOString(),
		}
	} catch {
		return lastErrorFromMessage(trimmed)
	}
}

export function stringifyMcpServerLastError(
	lastError: McpServerLastError | null,
): string | null {
	if (!lastError) return null
	return JSON.stringify({
		message: lastError.message,
		phase: lastError.phase,
		httpStatus: lastError.httpStatus,
		httpBodySnippet: lastError.httpBodySnippet,
		mcpEndpoint: lastError.mcpEndpoint,
		resource: lastError.resource,
		authServer: lastError.authServer,
		attemptId: lastError.attemptId,
		at: lastError.at,
	})
}

export function mcpServerLastErrorDisplayMessage(
	lastError: McpServerLastError | null,
): string | null {
	return lastError?.message ?? null
}

function lastErrorFromMessage(message: string): McpServerLastError {
	return {
		message: sanitizeMcpErrorSnippet(message, 500) ?? message,
		phase: null,
		httpStatus: parseHttpStatusFromMcpError(message),
		httpBodySnippet: sanitizeMcpErrorSnippet(message),
		mcpEndpoint: null,
		resource: null,
		authServer: null,
		attemptId: 'unknown',
		at: new Date(0).toISOString(),
	}
}

function parseStoredPhase(value: unknown): McpOAuthSettlePhase | null {
	if (value === 'token exchange') return 'token exchange'
	if (value === 'resource metadata') return 'resource metadata'
	if (value === 'mcp initialize') return 'mcp initialize'
	if (value === 'server/discover') return 'server/discover'
	if (value === 'tools/list') return 'tools/list'
	return null
}

function isStoredTokenRecoveryLead(error: string) {
	const lower = error.toLowerCase()
	return (
		lower.includes('could not be refreshed') ||
		lower.includes('could not keep this mcp server ready') ||
		lower.includes('has no refresh token to renew') ||
		lower.includes('advertised refresh tokens')
	)
}

function describeIncompleteMcpOAuthLead(input: {
	state: McpServerConnectionState
	authUrl: string | null
	error: string | null
	phase: McpOAuthSettlePhase | null
}): string {
	if (input.error && isStoredTokenRecoveryLead(input.error)) {
		return input.error
	}
	if (input.error) {
		return `Authorization completed at the identity provider, but ${decapitalizeLead(input.error)}`
	}
	if (input.state === 'authenticating' && input.authUrl) {
		return 'Authorization completed at the identity provider, but the MCP server still requires authorization'
	}
	if (input.state === 'authenticating') {
		return 'Authorization completed, but Kody could not finish connecting'
	}
	if (
		input.state === 'connected' ||
		input.state === 'discovering' ||
		input.phase === 'server/discover' ||
		input.phase === 'tools/list'
	) {
		return "Authorization completed at the identity provider, but tool discovery didn't finish"
	}
	return 'Authorization completed at the identity provider, but the MCP server did not become ready'
}

function reconnectHint(
	state: McpServerConnectionState,
	authUrl: string | null,
) {
	if (state === 'authenticating' && authUrl) {
		return 'Open the authorization link again from /account/mcp-servers.'
	}
	if (state === 'authenticating') {
		return 'Reconnect the server from /account/mcp-servers and approve access once more.'
	}
	return 'Reconnect it from /account/mcp-servers.'
}

function formatMcpOAuthSettleDetails(input: {
	phase: McpOAuthSettlePhase | null
	httpStatus: number | null
	httpBodySnippet: string | null
	mcpEndpoint: string | null
	resource: string | null
	authServer: string | null
	attemptId: string | null
}): string {
	const parts: Array<string> = []
	if (input.phase) parts.push(`phase ${input.phase}`)
	if (input.httpStatus != null) {
		parts.push(
			input.httpBodySnippet
				? `HTTP ${input.httpStatus}: ${input.httpBodySnippet}`
				: `HTTP ${input.httpStatus}`,
		)
	} else if (input.httpBodySnippet) {
		parts.push(input.httpBodySnippet)
	}
	if (input.mcpEndpoint) parts.push(`mcp ${input.mcpEndpoint}`)
	if (input.resource) parts.push(`resource ${input.resource}`)
	if (input.authServer) parts.push(`auth ${input.authServer}`)
	if (input.attemptId) parts.push(`id ${input.attemptId}`)
	return parts.join(', ')
}

function decapitalizeLead(value: string) {
	return value.replace(/^[A-Z]/, (letter) => letter.toLowerCase())
}

export function readOAuthDiscoveryUrls(value: unknown): {
	resource: string | null
	authServer: string | null
} {
	if (!value || typeof value !== 'object') {
		return { resource: null, authServer: null }
	}
	const record = value as Record<string, unknown>
	const resource = firstString(
		record['resource'],
		record['audience'],
		record['resource_url'],
	)
	const authorizationServers = record['authorization_servers']
	const authServer = Array.isArray(authorizationServers)
		? firstString(...authorizationServers)
		: firstString(
				record['authorization_server'],
				record['issuer'],
				record['authorization_endpoint'],
			)
	return {
		resource: sanitizePublicUrl(resource),
		authServer: sanitizePublicUrl(authServer),
	}
}

function firstString(...values: Array<unknown>) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return null
}
