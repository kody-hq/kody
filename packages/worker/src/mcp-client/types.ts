import { type JsonSchemaToolDescriptor } from '@cloudflare/codemode'
import { type Tool } from '@modelcontextprotocol/sdk/types.js'
import { type McpOAuthClientMode } from '@kody-internal/shared/mcp-servers.ts'
import { type McpServerConnectionEvent } from './connection-episodes.ts'

export type McpServerConnectionState =
	| 'authenticating'
	| 'connecting'
	| 'connected'
	| 'discovering'
	| 'ready'
	| 'failed'
	| 'disconnected'

/**
 * Observable post-IdP settle stages. Names match handshake / discovery
 * methods this repo already uses.
 */
export type McpOAuthSettlePhase =
	| 'token exchange'
	| 'resource metadata'
	| 'mcp initialize'
	| 'server/discover'
	| 'tools/list'

export type McpServerLastError = {
	message: string
	phase: McpOAuthSettlePhase | null
	httpStatus: number | null
	httpBodySnippet: string | null
	mcpEndpoint: string | null
	resource: string | null
	authServer: string | null
	attemptId: string
	at: string
}

/**
 * Tool metadata from a connected MCP server.
 *
 * Schemas use codemode's JSON Schema shape (JSONSchema7) so they line up with
 * capability registration. Agents' `connection.tools` types are a looser
 * JSON-Schema-like inference from MCP SDK v1.30 / client v2 and are narrowed
 * at the hub mapping boundary.
 */
export type McpServerToolDescriptor = {
	name: string
	title?: string
	description?: string
	inputSchema: JsonSchemaToolDescriptor['inputSchema']
	outputSchema?: JsonSchemaToolDescriptor['outputSchema']
	annotations?: Tool['annotations']
}

/**
 * Server card inside the hub Durable Object. `authUrl` is the provider's
 * authorization URL. It never crosses the hub client: callers get
 * `authorizationPending` and send people to the Kody consent page, which
 * reads the provider URL through `readPendingAuthorization`.
 */
export type McpHubServerSnapshot = {
	serverId: string
	name: string
	url: string
	state: McpServerConnectionState
	authUrl: string | null
	error: string | null
	lastError?: McpServerLastError | null
	hasRefreshToken?: boolean
	instructions: string | null
	tools: Array<McpServerToolDescriptor>
	/** Public id of the admin's pre-registered OAuth client, when one is set. */
	oauthClientId?: string | null
}

export type McpHubSnapshot = {
	servers: Array<McpHubServerSnapshot>
	connectionEvents?: Array<McpServerConnectionEvent>
}

export type McpHubConnectResult = {
	serverId: string
	state: McpServerConnectionState
	authUrl: string | null
	error: string | null
	toolCount: number
	lastError?: McpServerLastError | null
	hasRefreshToken?: boolean
}

/** True when the person must approve access on the Kody consent page. */
type McpAuthorizationPending = { authorizationPending: boolean }

export type McpServerSnapshot = Omit<McpHubServerSnapshot, 'authUrl'> &
	McpAuthorizationPending

export type McpClientHubSnapshot = {
	servers: Array<McpServerSnapshot>
	connectionEvents?: Array<McpServerConnectionEvent>
}

export type McpServerConnectResult = Omit<McpHubConnectResult, 'authUrl'> &
	McpAuthorizationPending

/** `changed` is false when a remove found no client, so nothing ran. */
export type McpHubOAuthClientChange = {
	changed: boolean
	previousClientId: string | null
	connection: McpHubConnectResult
}

export type McpServerOAuthClientChange = Omit<
	McpHubOAuthClientChange,
	'connection'
> & { connection: McpServerConnectResult }

/** What the consent page shows, plus the provider URL Continue redirects to. */
export type McpServerPendingAuthorization = {
	serverId: string
	name: string
	serverUrl: string
	authorizationUrl: string
	clientMode: McpOAuthClientMode
}

export type McpServerOAuthCallbackOutcome = {
	serverId: string | null
	authSuccess: boolean
	authError: string | null
	serverName: string | null
	authorizationNeeded: boolean
	lastError: McpServerLastError | null
}

/** Website status never starts a connection just to observe it. */
export type McpServerReadSnapshot = Omit<McpServerSnapshot, 'state'> & {
	state: McpServerSnapshot['state'] | 'unknown'
}
export type McpClientHubReadSnapshot = { servers: Array<McpServerReadSnapshot> }
