import {
	type McpHubServerSnapshot,
	type McpClientHubReadSnapshot,
} from './types.ts'

export const mcpReadSnapshotStorageKey = 'website-mcp-status-v1'

/** Explicit allowlist: never persist the provider authorization URL or credentials. */
export function projectMcpReadSnapshot(
	servers: Array<McpHubServerSnapshot>,
): McpClientHubReadSnapshot {
	return {
		servers: servers.map((server) => ({
			serverId: server.serverId,
			name: server.name,
			url: server.url,
			state: server.state,
			authorizationPending:
				server.state === 'authenticating' && Boolean(server.authUrl),
			error: server.error,
			lastError: server.lastError,
			hasRefreshToken: server.hasRefreshToken,
			instructions: server.instructions,
			tools: server.tools,
			oauthClientId: server.oauthClientId,
		})),
	}
}

/** A durable observation cannot prove that a hibernated connection is still live. */
export function coldMcpReadSnapshot(
	snapshot: McpClientHubReadSnapshot | undefined,
): McpClientHubReadSnapshot {
	return {
		servers: (snapshot?.servers ?? []).map((server) => ({
			...server,
			state: 'unknown',
			authorizationPending: false,
		})),
	}
}
