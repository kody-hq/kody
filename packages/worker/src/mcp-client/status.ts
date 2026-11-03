import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { getCachedMcpClientHubSnapshot } from './hub-client.ts'
import type { McpServerConnectionState } from './types.ts'

export type McpServerStatus = {
	state: McpServerConnectionState | 'unknown'
	serverId: string
	name: string
	ready: boolean
	toolCount: number
	message: string
	error: string | null
}

function serverLabel(name: string) {
	return `MCP server "${name}"`
}

export async function getMcpServerStatus(input: {
	env: Env
	userId: OwnerId
	ref: McpServerRef
}): Promise<McpServerStatus> {
	const label = serverLabel(input.ref.name)
	try {
		const snapshot = await getCachedMcpClientHubSnapshot({
			env: input.env,
			userId: input.userId,
		})
		const server = snapshot.servers.find(
			(entry) => entry.serverId === input.ref.serverId,
		)
		if (!server) {
			return {
				state: 'unknown',
				serverId: input.ref.serverId,
				name: input.ref.name,
				ready: false,
				toolCount: 0,
				message: `The ${label} has no active connection. Reconnect it from /account/mcp-servers or with mcpServerReconnect.`,
				error: null,
			}
		}
		const toolCount = server.tools.length
		const ready = server.state === 'ready'
		return {
			state: server.state,
			serverId: server.serverId,
			name: server.name,
			ready,
			toolCount,
			message: buildStatusMessage({
				label,
				state: server.state,
				toolCount,
				error: server.error,
			}),
			error: server.error,
		}
	} catch (error) {
		const message = getErrorMessage(error)
		return {
			state: 'unknown',
			serverId: input.ref.serverId,
			name: input.ref.name,
			ready: false,
			toolCount: 0,
			message: `Kody could not determine the status for the ${label}.`,
			error: message,
		}
	}
}

function buildStatusMessage(input: {
	label: string
	state: McpServerConnectionState
	toolCount: number
	error: string | null
}) {
	switch (input.state) {
		case 'ready':
			return input.toolCount > 0
				? `The ${input.label} is connected and exposing ${input.toolCount} tool${input.toolCount === 1 ? '' : 's'}.`
				: `The ${input.label} is connected, but it has not exposed any tools.`
		case 'authenticating':
			return input.error
				? `The ${input.label} is waiting for OAuth authorization: ${input.error}`
				: `The ${input.label} is waiting for OAuth authorization. Complete the authorization from /account/mcp-servers.`
		case 'connecting':
		case 'connected':
		case 'discovering':
			return `The ${input.label} is still connecting. Retry shortly.`
		case 'failed':
			return `The ${input.label} failed to connect${input.error ? `: ${input.error}` : '.'}`
		case 'disconnected':
			return `The ${input.label} is not connected. Reconnect it from /account/mcp-servers or with mcpServerReconnect.`
		default: {
			const exhaustive: never = input.state
			throw new Error(`Unhandled MCP server state: ${String(exhaustive)}`)
		}
	}
}

export function formatMcpServerUnavailableMessage(status: McpServerStatus) {
	if (status.ready && status.toolCount > 0) {
		return status.message
	}
	return `${status.message} Check mcpServerList for connection status.`
}
