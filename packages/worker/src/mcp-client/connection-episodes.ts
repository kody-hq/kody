import type { McpServerConnectionState } from './types.ts'

export const mcpServerDisconnectedTopic = 'mcp.server.disconnected'
export const mcpServerReconnectedTopic = 'mcp.server.reconnected'

export const mcpLightweightReconnectAttempts = 2
export const mcpLightweightReconnectBackoffMs = [250] as const
export const mcpLightweightReconnectDiscoverTimeoutMs = 5_000

export const mcpConnectionEpisodeStoragePrefix = 'mcp-connection-episode/'
export const mcpConnectionEventsPendingStorageKey =
	'mcp-connection-events-pending'

export type McpServerConnectionEventTopic =
	| typeof mcpServerDisconnectedTopic
	| typeof mcpServerReconnectedTopic

export type McpConnectionEpisodeRecord = {
	lastObservedState: McpServerConnectionState | 'unknown'
	wasReady: boolean
	episodeId: string | null
	disconnectedEmitted: boolean
}

export type McpServerConnectionEvent = {
	topic: McpServerConnectionEventTopic
	eventId: string
	episodeId: string
	serverId: string
	serverName: string
	state: McpServerConnectionState
	previousState: McpServerConnectionState | 'unknown'
	observedAt: string
}

export type McpConnectionObserveDecision = {
	next: McpConnectionEpisodeRecord
	shouldRetry: boolean
	event: {
		topic: McpServerConnectionEventTopic
		episodeId: string
		previousState: McpServerConnectionState | 'unknown'
	} | null
}

export function mcpConnectionEpisodeStorageKey(serverId: string) {
	return `${mcpConnectionEpisodeStoragePrefix}${serverId}`
}

export function createInitialMcpConnectionEpisode(): McpConnectionEpisodeRecord {
	return {
		lastObservedState: 'unknown',
		wasReady: false,
		episodeId: null,
		disconnectedEmitted: false,
	}
}

/**
 * Token-recovery parks can lose the in-storage `wasReady` bit (new hub
 * incarnation, peek-only last_error stamp). Treat the server as previously
 * ready so `authenticating` classifies as working → failed, not first-add.
 */
export function episodeAsPreviouslyReady(
	previous: McpConnectionEpisodeRecord,
): McpConnectionEpisodeRecord {
	if (previous.wasReady) return previous
	return {
		...previous,
		wasReady: true,
		lastObservedState:
			previous.lastObservedState === 'unknown'
				? 'ready'
				: previous.lastObservedState,
	}
}

export function isMcpServerUnavailableState(
	state: McpServerConnectionState,
): boolean {
	return (
		state === 'disconnected' || state === 'failed' || state === 'authenticating'
	)
}

export function isMcpServerInFlightState(
	state: McpServerConnectionState,
): boolean {
	return (
		state === 'connecting' || state === 'connected' || state === 'discovering'
	)
}

/**
 * Classify one observed hub state against the persisted episode.
 *
 * Ready is recorded the first time we see it. A later unavailable state
 * retries (except `authenticating`, which needs the user) and then emits
 * `mcp.server.disconnected` once per episode. Recovery to ready emits
 * `mcp.server.reconnected` for that same episode.
 */
export function observeMcpConnectionState(input: {
	previous: McpConnectionEpisodeRecord
	currentState: McpServerConnectionState
	retryCompleted: boolean
	createEpisodeId: () => string
}): McpConnectionObserveDecision {
	const previousState = input.previous.lastObservedState

	if (input.currentState === 'ready') {
		if (
			input.previous.wasReady &&
			input.previous.episodeId &&
			input.previous.disconnectedEmitted
		) {
			return {
				next: {
					lastObservedState: 'ready',
					wasReady: true,
					episodeId: null,
					disconnectedEmitted: false,
				},
				shouldRetry: false,
				event: {
					topic: mcpServerReconnectedTopic,
					episodeId: input.previous.episodeId,
					previousState,
				},
			}
		}
		return {
			next: {
				lastObservedState: 'ready',
				wasReady: true,
				episodeId: null,
				disconnectedEmitted: false,
			},
			shouldRetry: false,
			event: null,
		}
	}

	if (isMcpServerInFlightState(input.currentState)) {
		return {
			next: {
				...input.previous,
				lastObservedState: input.currentState,
			},
			shouldRetry: false,
			event: null,
		}
	}

	if (!input.previous.wasReady) {
		return {
			next: {
				...input.previous,
				lastObservedState: input.currentState,
			},
			shouldRetry: false,
			event: null,
		}
	}

	if (input.previous.disconnectedEmitted && input.previous.episodeId) {
		return {
			next: {
				...input.previous,
				lastObservedState: input.currentState,
			},
			shouldRetry: false,
			event: null,
		}
	}

	const skipRetry =
		input.retryCompleted || input.currentState === 'authenticating'
	if (!skipRetry) {
		return {
			next: input.previous,
			shouldRetry: true,
			event: null,
		}
	}

	const episodeId = input.previous.episodeId ?? input.createEpisodeId()
	return {
		next: {
			lastObservedState: input.currentState,
			wasReady: true,
			episodeId,
			disconnectedEmitted: true,
		},
		shouldRetry: false,
		event: {
			topic: mcpServerDisconnectedTopic,
			episodeId,
			previousState,
		},
	}
}
