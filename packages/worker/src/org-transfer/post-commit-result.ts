import { buildMcpServerAuthorizeUrl } from '#worker/mcp-client/authorize-consent.ts'
import { isAuthorizationPending } from '#worker/mcp-client/hub-client.ts'
import type {
	McpHubConnectResult,
	McpServerConnectionState,
} from '#worker/mcp-client/types.ts'
import type { OrgTransferFinding } from './findings.ts'

/**
 * A moved MCP server after the target hub dialed it. `state` is null when
 * the connect step failed (see the matching post-commit warning).
 * `source_removed` is false when the source hub still holds the server, so
 * both hubs may refresh its tokens until an operator removes it.
 * `authorize_url` is the Kody consent page, never the provider URL.
 */
export type OrgTransferMcpConnection = {
	id: string
	name: string
	source_removed: boolean
	state: McpServerConnectionState | null
	needs_authorization: boolean
	authorize_url: string | null
}

export type OrgTransferPostCommitResult = {
	leftovers: Record<string, number>
	warnings: Array<OrgTransferFinding>
	mcpConnections: Array<OrgTransferMcpConnection>
}

export function describeOrgTransferMcpConnection(input: {
	serverId: string
	name: string
	sourceRemoved: boolean
	result: McpHubConnectResult | null
	appOrigin: string
	toSlug: string
}): OrgTransferMcpConnection {
	const needsAuthorization = input.result
		? isAuthorizationPending(input.result)
		: false
	return {
		id: input.serverId,
		name: input.name,
		source_removed: input.sourceRemoved,
		state: input.result?.state ?? null,
		needs_authorization: needsAuthorization,
		authorize_url: needsAuthorization
			? buildMcpServerAuthorizeUrl({
					appOrigin: input.appOrigin,
					orgSlug: input.toSlug,
					serverId: input.serverId,
				})
			: null,
	}
}
