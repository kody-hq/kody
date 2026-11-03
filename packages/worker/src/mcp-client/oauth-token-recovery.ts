import {
	buildMcpServerLastError,
	sanitizePublicUrl,
} from './oauth-settle-error.ts'
import type { McpServerLastError } from './types.ts'

export const mcpOAuthTokenRecoveryStoragePrefix = 'mcp-oauth-token-recovery/'
export const mcpOAuthRefreshTokenStoragePrefix = 'mcp-oauth-refresh-token/'
export const mcpOAuthRefreshGrantOmittedStoragePrefix =
	'mcp-oauth-refresh-grant-omitted/'

export type McpOAuthTokenPresence = {
	hasAccessToken: boolean
	hasRefreshToken: boolean
}

export function mcpOAuthTokenRecoveryStorageKey(serverId: string) {
	return `${mcpOAuthTokenRecoveryStoragePrefix}${serverId}`
}

export function mcpOAuthRefreshTokenStorageKey(serverId: string) {
	return `${mcpOAuthRefreshTokenStoragePrefix}${serverId}`
}

export function mcpOAuthRefreshGrantOmittedStorageKey(serverId: string) {
	return `${mcpOAuthRefreshGrantOmittedStoragePrefix}${serverId}`
}

/**
 * Prefer the live client identity when several `/token` blobs share a server
 * prefix (for example a leftover DCR id beside a CIMD URL). A refresh token
 * under the preferred id wins; otherwise any blob that still has a refresh
 * token; otherwise the preferred id even without tokens; otherwise the first
 * sibling.
 */
export function preferMcpOAuthStoredClientId(input: {
	preferredClientId: string | null
	siblings: ReadonlyArray<{ clientId: string; hasRefreshToken: boolean }>
}): string | null {
	if (input.siblings.length === 0) {
		return input.preferredClientId
	}
	const preferred = input.preferredClientId?.trim() || null
	if (preferred) {
		const preferredWithRefresh = input.siblings.find(
			(sibling) => sibling.clientId === preferred && sibling.hasRefreshToken,
		)
		if (preferredWithRefresh) return preferredWithRefresh.clientId
	}
	const anyWithRefresh = input.siblings.find(
		(sibling) => sibling.hasRefreshToken,
	)
	if (anyWithRefresh) return anyWithRefresh.clientId
	if (
		preferred &&
		input.siblings.some((sibling) => sibling.clientId === preferred)
	) {
		return preferred
	}
	return input.siblings[0]?.clientId ?? preferred
}

export function readMcpOAuthRefreshToken(tokens: unknown): string | null {
	if (!tokens || typeof tokens !== 'object') return null
	const value = (tokens as Record<string, unknown>)['refresh_token']
	if (typeof value !== 'string' || value.trim().length === 0) return null
	return value
}

export function parseStoredMcpOAuthRefreshToken(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) return value.trim()
	return readMcpOAuthRefreshToken(value)
}

export function mcpOAuthServerStoragePrefix(input: {
	clientName: string
	serverId: string
}) {
	return `/${input.clientName}/${input.serverId}/`
}

export function clientIdFromMcpOAuthTokenStorageKey(input: {
	clientName: string
	serverId: string
	key: string
}): string | null {
	const prefix = mcpOAuthServerStoragePrefix(input)
	const suffix = '/token'
	if (!input.key.startsWith(prefix) || !input.key.endsWith(suffix)) {
		return null
	}
	const clientId = input.key.slice(prefix.length, -suffix.length)
	return clientId.length > 0 ? clientId : null
}

export function readMcpOAuthTokenPresence(
	tokens: unknown,
): McpOAuthTokenPresence {
	if (!tokens || typeof tokens !== 'object') {
		return { hasAccessToken: false, hasRefreshToken: false }
	}
	const record = tokens as Record<string, unknown>
	return {
		hasAccessToken:
			typeof record['access_token'] === 'string' &&
			record['access_token'].trim().length > 0,
		hasRefreshToken:
			typeof record['refresh_token'] === 'string' &&
			record['refresh_token'].trim().length > 0,
	}
}

export function mcpOAuthDiscoveryAdvertisesRefresh(discovery: unknown) {
	if (!discovery || typeof discovery !== 'object') return false
	const record = discovery as Record<string, unknown>
	const candidates = [
		record,
		record['authorizationServerMetadata'],
		record['resourceMetadata'],
	]
	return candidates.some((candidate) => {
		if (!candidate || typeof candidate !== 'object') return false
		const nested = candidate as Record<string, unknown>
		const grantTypes = readStringList(nested['grant_types_supported'])
		if (grantTypes.includes('refresh_token')) return true
		const scopes = readStringList(nested['scopes_supported'])
		return scopes.includes('offline_access') || scopes.includes('refresh_token')
	})
}

function readStringList(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Authorization servers often omit `refresh_token` on refresh (and
 * sometimes on a second authorization-code grant). RFC 6749 says the
 * client must keep the existing refresh token in that case. The Agents
 * SDK `saveTokens` replaces the whole blob, so a merge has to happen
 * before the write.
 */
export function mergeMcpOAuthTokens(input: {
	incoming: unknown
	existing: unknown
}): unknown {
	if (!input.incoming || typeof input.incoming !== 'object') {
		return input.incoming
	}
	const incomingPresence = readMcpOAuthTokenPresence(input.incoming)
	if (incomingPresence.hasRefreshToken) return input.incoming
	const existingPresence = readMcpOAuthTokenPresence(input.existing)
	if (!existingPresence.hasRefreshToken) return input.incoming
	if (!input.existing || typeof input.existing !== 'object') {
		return input.incoming
	}
	return {
		...(input.incoming as Record<string, unknown>),
		refresh_token: (input.existing as Record<string, unknown>)['refresh_token'],
	}
}

export function preservedMcpOAuthRefreshToken(
	sources: ReadonlyArray<unknown>,
): string | null {
	for (const source of sources) {
		const refreshToken = readMcpOAuthRefreshToken(source)
		if (refreshToken) return refreshToken
	}
	return null
}

/**
 * Put a previously stored refresh token onto an access-token-only blob.
 * Does not invent tokens: `sources` must already contain the refresh
 * token from storage.
 */
export function withPreservedMcpOAuthRefreshToken(input: {
	incoming: unknown
	sources: ReadonlyArray<unknown>
}): unknown {
	if (!input.incoming || typeof input.incoming !== 'object') {
		return input.incoming
	}
	if (readMcpOAuthTokenPresence(input.incoming).hasRefreshToken) {
		return input.incoming
	}
	const refreshToken = preservedMcpOAuthRefreshToken(input.sources)
	if (!refreshToken) return input.incoming
	return {
		...(input.incoming as Record<string, unknown>),
		refresh_token: refreshToken,
	}
}

/**
 * Rebuild a readable token blob after restore when SQL `client_id` is
 * missing and `tokens()` would otherwise return empty.
 */
export function restoreReadableMcpOAuthTokens(input: {
	blob: unknown
	sources: ReadonlyArray<unknown>
}): unknown {
	const candidates = [input.blob, ...input.sources]
	const withAccess = candidates.find(
		(source) => readMcpOAuthTokenPresence(source).hasAccessToken,
	)
	const incoming = withAccess ?? input.blob
	if (incoming && typeof incoming === 'object') {
		return withPreservedMcpOAuthRefreshToken({
			incoming,
			sources: candidates,
		})
	}
	const refreshToken = preservedMcpOAuthRefreshToken(candidates)
	return refreshToken ? { refresh_token: refreshToken } : input.blob
}

export function shouldAttemptMcpOAuthRefresh(presence: McpOAuthTokenPresence) {
	return presence.hasAccessToken || presence.hasRefreshToken
}

/**
 * Queue `mcp.server.disconnected` for a durable token-recovery park.
 * A stale access token with no refresh token is the "Authorization
 * required / no refresh token / phase token exchange" card — still a
 * working → failed flip even when episode `wasReady` was never written.
 * A first Authorize that just saved tokens (typically including a
 * refresh token) is not a park: do not infer previously-ready from
 * refresh-token presence alone.
 */
export function shouldQueueMcpTokenRecoveryDisconnected(input: {
	wasReady: boolean
	presence: McpOAuthTokenPresence
	hasTokenRecoveryLastError: boolean
}) {
	return (
		input.wasReady ||
		input.hasTokenRecoveryLastError ||
		(input.presence.hasAccessToken && !input.presence.hasRefreshToken)
	)
}

export function describeMcpOAuthTokenRecovery(input: {
	hadRefreshToken: boolean
	stillHasRefreshToken: boolean
}): string {
	if (input.hadRefreshToken && !input.stillHasRefreshToken) {
		return 'Stored OAuth tokens could not be refreshed. The authorization server rejected or consumed the refresh token, so Kody discarded it and needs a new authorization'
	}
	if (input.hadRefreshToken) {
		return 'Stored OAuth tokens could not keep this MCP server ready. Refresh did not restore the connection, so Kody started a new authorization'
	}
	return "This MCP server's stored access token is no longer usable and Kody has no refresh token to renew it"
}

export function describeMcpOAuthMissingRefreshGrant() {
	return "This MCP server's authorization server advertised refresh tokens, but the token response did not include a refresh token. The access token will expire and Kody cannot renew it"
}

export function isMcpOAuthTokenRecoveryLastError(
	lastError: McpServerLastError | null,
): boolean {
	if (!lastError || lastError.phase !== 'token exchange') return false
	const message = lastError.message.toLowerCase()
	return (
		message.includes('could not be refreshed') ||
		message.includes('could not keep this mcp server ready') ||
		message.includes('has no refresh token to renew')
	)
}

export function isMcpOAuthMissingRefreshGrantLastError(
	lastError: McpServerLastError | null,
): boolean {
	if (!lastError || lastError.phase !== 'token exchange') return false
	return lastError.message.toLowerCase().includes('advertised refresh tokens')
}

export function isMcpOAuthGrantIssueLastError(
	lastError: McpServerLastError | null,
): boolean {
	return (
		isMcpOAuthTokenRecoveryLastError(lastError) ||
		isMcpOAuthMissingRefreshGrantLastError(lastError)
	)
}

export function buildMcpOAuthTokenRecoveryLastError(input: {
	authUrl: string | null
	mcpEndpoint?: string | null
	hadRefreshToken: boolean
	stillHasRefreshToken: boolean
	attemptId?: string | null
	at?: string
}): McpServerLastError {
	const reason = describeMcpOAuthTokenRecovery({
		hadRefreshToken: input.hadRefreshToken,
		stillHasRefreshToken: input.stillHasRefreshToken,
	})
	return buildMcpServerLastError({
		state: 'authenticating',
		authUrl: input.authUrl,
		error: reason,
		phase: 'token exchange',
		mcpEndpoint: sanitizePublicUrl(input.mcpEndpoint),
		attemptId: input.attemptId?.trim() || crypto.randomUUID(),
		at: input.at,
	})
}

export function buildMcpOAuthMissingRefreshGrantLastError(input: {
	authUrl: string | null
	mcpEndpoint?: string | null
	attemptId?: string | null
	at?: string
}): McpServerLastError {
	return buildMcpServerLastError({
		state: 'ready',
		authUrl: input.authUrl,
		error: describeMcpOAuthMissingRefreshGrant(),
		phase: 'token exchange',
		mcpEndpoint: sanitizePublicUrl(input.mcpEndpoint),
		attemptId: input.attemptId?.trim() || crypto.randomUUID(),
		at: input.at,
	})
}
