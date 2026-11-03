import { isIncompleteDiscoverState } from './oauth-settle-error.ts'
import type { McpVersionNegotiationMode } from './reconnect.ts'
import type { McpServerConnectionState } from './types.ts'

export const mcpLegacyHandshakeStoragePrefix = 'mcp-legacy-handshake/'
export const mcpLegacyHandshakeFallback = 'catalog-timeout' as const

export function mcpLegacyHandshakeStorageKey(serverId: string) {
	return `${mcpLegacyHandshakeStoragePrefix}${serverId}`
}

export function readMcpVersionNegotiationMode(
	client: unknown,
): McpVersionNegotiationMode {
	if (!client || typeof client !== 'object') return 'auto'
	const negotiation = Reflect.get(client, 'versionNegotiation')
	if (!negotiation || typeof negotiation !== 'object') return 'auto'
	return Reflect.get(negotiation, 'mode') === 'legacy' ? 'legacy' : 'auto'
}

/**
 * Modern `auto` already completed transport + handshake (`connected` /
 * `discovering`) but catalog never reached `ready`. Retry the same server
 * with the 2025 `initialize` dialect instead of pinning a hostname.
 */
export function shouldRetryLegacyHandshake(input: {
	state: McpServerConnectionState
	client?: unknown
}): boolean {
	return (
		readMcpVersionNegotiationMode(input.client) === 'auto' &&
		isIncompleteDiscoverState(input.state)
	)
}

export function shouldKeepPersistedLegacyHandshake(input: {
	serverId: string
	keepLegacyHandshakeIds?: ReadonlySet<string>
}): boolean {
	return input.keepLegacyHandshakeIds?.has(input.serverId) === true
}
