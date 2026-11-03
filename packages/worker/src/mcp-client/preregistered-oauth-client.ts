import type { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider'

/**
 * An admin-supplied OAuth client for one MCP server, as the hub stores it.
 * The secret stays sealed at rest and is opened only to hand it to the MCP
 * SDK token request.
 */
export type SealedMcpPreRegisteredOAuthClient = {
	clientId: string
	sealedClientSecret: string
}

export type McpPreRegisteredOAuthClientInformation = {
	client_id: string
	client_secret: string
}

export const mcpPreRegisteredOAuthClientStoragePrefix =
	'mcp-oauth-preregistered-client:'
const maxClientIdLength = 512
const maxClientSecretLength = 4096

export function mcpPreRegisteredOAuthClientStorageKey(serverId: string) {
	return `${mcpPreRegisteredOAuthClientStoragePrefix}${serverId}`
}

export function parseSealedMcpPreRegisteredOAuthClient(
	value: unknown,
): SealedMcpPreRegisteredOAuthClient | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const clientId = record['clientId']
	const sealedClientSecret = record['sealedClientSecret']
	if (typeof clientId !== 'string' || !clientId) return null
	if (typeof sealedClientSecret !== 'string' || !sealedClientSecret) return null
	return { clientId, sealedClientSecret }
}

export type McpPreRegisteredOAuthClientInputResult =
	| { ok: true; clientId: string; clientSecret: string }
	| { ok: false; error: string }

/** Validate what an admin typed on the settings page. */
export function normalizeMcpPreRegisteredOAuthClientInput(input: {
	clientId: unknown
	clientSecret: unknown
}): McpPreRegisteredOAuthClientInputResult {
	const clientId =
		typeof input.clientId === 'string' ? input.clientId.trim() : ''
	const clientSecret =
		typeof input.clientSecret === 'string' ? input.clientSecret.trim() : ''
	if (!clientId) return { ok: false, error: 'Client ID is required.' }
	if (!clientSecret) return { ok: false, error: 'Client secret is required.' }
	if (clientId.length > maxClientIdLength || /\s/.test(clientId)) {
		return {
			ok: false,
			error: `Client ID must be at most ${maxClientIdLength} characters with no spaces.`,
		}
	}
	if (clientSecret.length > maxClientSecretLength || /\s/.test(clientSecret)) {
		return {
			ok: false,
			error: `Client secret must be at most ${maxClientSecretLength} characters with no spaces.`,
		}
	}
	return { ok: true, clientId, clientSecret }
}

/**
 * Present the pre-registered client ahead of anything stored. The MCP SDK
 * reads `clientInformation()` before it considers CIMD or DCR, so a
 * configured client always wins. The SDK re-saves unstamped client info to
 * bind it to the issuer; that save is skipped for the pre-registered client
 * so its secret never lands in plain DO storage.
 */
export function installMcpPreRegisteredOAuthClient(
	provider: DurableObjectOAuthClientProvider,
	resolve: (
		serverId: string,
	) => Promise<McpPreRegisteredOAuthClientInformation | null>,
) {
	if (
		typeof provider.clientInformation !== 'function' ||
		typeof provider.saveClientInformation !== 'function'
	) {
		return
	}
	const readClientInformation = provider.clientInformation.bind(provider)
	const saveClientInformation = provider.saveClientInformation.bind(provider)
	const resolveForProvider = async () => {
		const serverId = readServerId(provider)
		return serverId ? await resolve(serverId) : null
	}
	provider.clientInformation = async (context) => {
		const preRegistered = await resolveForProvider()
		if (preRegistered) {
			provider.clientId = preRegistered.client_id
			return { ...preRegistered }
		}
		return await readClientInformation(context)
	}
	provider.saveClientInformation = async (information, context) => {
		const preRegistered = await resolveForProvider()
		if (preRegistered && information.client_id === preRegistered.client_id) {
			provider.clientId = preRegistered.client_id
			return
		}
		await saveClientInformation(information, context)
	}
}

const missingRegistrationMessage =
	'does not support dynamic client registration'

/**
 * The MCP SDK fails with "Incompatible auth server: does not support dynamic
 * client registration" when the authorization server offers neither CIMD nor
 * DCR and no client is configured. Say what fixes it.
 */
export function describeMcpOAuthClientRegistrationError(message: string) {
	if (!message.toLowerCase().includes(missingRegistrationMessage)) {
		return message
	}
	return "This server's authorization server supports neither Client ID Metadata Documents nor dynamic client registration, so Kody cannot register itself. An admin can add a pre-registered OAuth client (client ID and secret) in this server's settings."
}

function readServerId(provider: DurableObjectOAuthClientProvider) {
	try {
		const value = provider.serverId
		return typeof value === 'string' && value ? value : null
	} catch {
		return null
	}
}
