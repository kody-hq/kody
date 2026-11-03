import {
	buildMcpServerLastError,
	inferMcpOAuthSettlePhase,
	parseHttpStatusFromMcpError,
	sanitizeMcpErrorSnippet,
	sanitizePublicUrl,
	type McpOAuthSettlePhase,
	type McpServerLastError,
} from './oauth-settle-error.ts'
import type {
	McpServerConnectionState,
	McpServerOAuthCallbackOutcome,
} from './types.ts'

export type McpOAuthCallbackConnection = {
	state: McpServerConnectionState
	authUrl: string | null
	error: string | null
	phase?: McpOAuthSettlePhase | null
	mcpEndpoint?: string | null
	resource?: string | null
	authServer?: string | null
	httpStatus?: number | null
	httpBodySnippet?: string | null
}

/**
 * Decide the user-facing OAuth callback outcome from the Agents SDK result
 * plus the post-establish connection snapshot.
 *
 * The SDK's `authSuccess` only means the authorization code was accepted (or
 * treated as already accepted). Kody must not report success until the MCP
 * connection is actually `ready`. Otherwise users can land on
 * "Authorization required" with no auth URL and no error — the Clerk / Convex
 * MCP failure mode reported by Bernardo.
 */
export function resolveMcpOAuthCallbackOutcome(input: {
	sdkAuthSuccess: boolean
	sdkAuthError: string | null
	serverId: string | null
	serverName: string | null
	connection: McpOAuthCallbackConnection | null
	attemptId?: string | null
}): McpServerOAuthCallbackOutcome {
	const { serverId, serverName } = input

	if (!input.sdkAuthSuccess || !serverId) {
		return {
			serverId,
			authSuccess: false,
			authError: input.sdkAuthError ?? 'Authorization failed.',
			serverName,
			authorizationNeeded: false,
			lastError: null,
		}
	}

	if (!input.connection) {
		return {
			serverId,
			authSuccess: false,
			authError:
				'Authorization completed, but Kody lost the MCP server connection. Try reconnecting from /account/mcp-servers.',
			serverName,
			authorizationNeeded: false,
			lastError: null,
		}
	}

	if (input.connection.state === 'ready') {
		return {
			serverId,
			authSuccess: true,
			authError: null,
			serverName,
			authorizationNeeded: false,
			lastError: null,
		}
	}

	const lastError = buildIncompleteMcpOAuthLastError({
		connection: input.connection,
		attemptId: input.attemptId,
	})
	return {
		serverId,
		authSuccess: false,
		authError: lastError.message,
		serverName,
		authorizationNeeded: false,
		lastError,
	}
}

export function describeIncompleteMcpOAuthConnection(
	connection: McpOAuthCallbackConnection & { attemptId?: string | null },
): string {
	return buildIncompleteMcpOAuthLastError({
		connection,
		attemptId: connection.attemptId,
	}).message
}

function buildIncompleteMcpOAuthLastError(input: {
	connection: McpOAuthCallbackConnection
	attemptId?: string | null
}): McpServerLastError {
	const error = input.connection.error
	return buildMcpServerLastError({
		state: input.connection.state,
		authUrl: input.connection.authUrl,
		error,
		phase:
			input.connection.phase ??
			inferMcpOAuthSettlePhase({
				state: input.connection.state,
				error,
			}),
		httpStatus:
			input.connection.httpStatus ?? parseHttpStatusFromMcpError(error),
		httpBodySnippet: sanitizeMcpErrorSnippet(input.connection.httpBodySnippet),
		mcpEndpoint: sanitizePublicUrl(input.connection.mcpEndpoint),
		resource: sanitizePublicUrl(input.connection.resource),
		authServer: sanitizePublicUrl(input.connection.authServer),
		attemptId: input.attemptId?.trim() || crypto.randomUUID(),
	})
}

/**
 * Agents SDK quirk: `connectToServer` can leave `connectionState` as
 * `authenticating` while returning FAILED when `authUrl` is missing, and
 * `oauthCallbackSuccess` clears the stored auth URL. Detect that stuck state
 * so callers can recover before surfacing success/error to the user.
 */
export function isStuckMcpAuthenticatingWithoutAuthUrl(connection: {
	state: McpServerConnectionState
	authUrl: string | null
}): boolean {
	return connection.state === 'authenticating' && !connection.authUrl
}
