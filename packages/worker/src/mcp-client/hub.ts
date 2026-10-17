import {
	mcpReadSnapshotStorageKey,
	projectMcpReadSnapshot,
	coldMcpReadSnapshot,
} from './read-snapshot.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { Lifecycle } from 'agents/lifecycle'
import { MCPClientManager } from 'agents/mcp/client'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	decryptMcpServerOAuthClientSecret,
	mcpServerOAuthClientSecretContext,
} from '#mcp/secrets/crypto.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	createMcpClientOAuthProvider,
	mcpClientName,
	resolveMcpOAuthClientMode,
} from './client-id-metadata.ts'
import {
	isStuckMcpAuthenticatingWithoutAuthUrl,
	resolveMcpOAuthCallbackOutcome,
} from './oauth-callback-outcome.ts'
import {
	mcpLegacyHandshakeFallback,
	mcpLegacyHandshakeStorageKey,
	mcpLegacyHandshakeStoragePrefix,
	readMcpVersionNegotiationMode,
	shouldRetryLegacyHandshake,
} from './legacy-handshake.ts'
import {
	buildIncompleteDiscoverLastError,
	isFormattedMcpOAuthSettleMessage,
	isIncompleteDiscoverState,
	parseStoredMcpServerLastError,
	readAttemptIdFromSettleMessage,
	readOAuthDiscoveryUrls,
	sanitizePublicUrl,
} from './oauth-settle-error.ts'
import {
	buildMcpOAuthMissingRefreshGrantLastError,
	buildMcpOAuthTokenRecoveryLastError,
	isMcpOAuthGrantIssueLastError,
	isMcpOAuthMissingRefreshGrantLastError,
	isMcpOAuthTokenRecoveryLastError,
	mcpOAuthDiscoveryAdvertisesRefresh,
	mcpOAuthRefreshGrantOmittedStorageKey,
	mcpOAuthRefreshTokenStorageKey,
	mcpOAuthTokenRecoveryStorageKey,
	mcpOAuthTokenRecoveryStoragePrefix,
	readMcpOAuthTokenPresence,
	shouldAttemptMcpOAuthRefresh,
	shouldQueueMcpTokenRecoveryDisconnected,
	type McpOAuthTokenPresence,
} from './oauth-token-recovery.ts'
import {
	outboundMcpClientOptions,
	reconnectMcpServerOptions,
} from './reconnect.ts'
import {
	describeMcpOAuthClientRegistrationError,
	mcpPreRegisteredOAuthClientStorageKey,
	mcpPreRegisteredOAuthClientStoragePrefix,
	parseSealedMcpPreRegisteredOAuthClient,
	type McpPreRegisteredOAuthClientInformation,
	type SealedMcpPreRegisteredOAuthClient,
} from './preregistered-oauth-client.ts'
import {
	hasForeignTransferStorageKey,
	type McpHubServerImportResult,
	type McpHubServerTransfer,
	type McpHubStagedServer,
	mcpServerOAuthStoragePrefix,
	mcpServerSidecarStorageKeys,
	mcpTransferStagingStorageKey,
	mcpTransferStagingStoragePrefix,
} from './hub-transfer.ts'
import {
	parsePersistedMcpServerOptions,
	sanitizePersistedMcpServerOptions,
	sanitizeStoredMcpSessions,
} from './restore.ts'
import {
	mcpOAuthAttemptStorageKey,
	mcpOAuthAttemptVerifiedStorageKey,
	readMcpOAuthAttemptIdentity,
	writeMcpOAuthAttemptIdentity,
	type McpOAuthAttemptActor,
} from './oauth-attempt.ts'
import { extractMcpServerIdFromOAuthState } from './oauth-state.ts'
import { withStaticTransportHeaders } from './transport-headers.ts'
import { clearLiveMcpTransportSession } from './transport-session.ts'
import {
	createInitialMcpConnectionEpisode,
	episodeAsPreviouslyReady,
	mcpConnectionEpisodeStorageKey,
	mcpConnectionEventsPendingStorageKey,
	mcpLightweightReconnectAttempts,
	mcpLightweightReconnectBackoffMs,
	mcpLightweightReconnectDiscoverTimeoutMs,
	observeMcpConnectionState,
	type McpConnectionEpisodeRecord,
	type McpServerConnectionEvent,
} from './connection-episodes.ts'
import {
	type McpHubConnectResult,
	type McpHubOAuthClientChange,
	type McpClientHubReadSnapshot,
	type McpHubServerSnapshot,
	type McpHubSnapshot,
	type McpServerConnectionState,
	type McpServerLastError,
	type McpServerOAuthCallbackOutcome,
	type McpServerPendingAuthorization,
	type McpServerToolDescriptor,
} from './types.ts'

const mcpClientVersion = '1.0.0'
const connectionSettleTimeoutMs = 8_000
const discoverTimeoutMs = 15_000
const oauthRecoveryMessage =
	'Authorization needed. Reconnect the MCP server and approve access once more.'

function clientIdFromStoredAuthUrl(authUrl: string | null) {
	if (!authUrl) return null
	try {
		return new URL(authUrl).searchParams.get('client_id')
	} catch {
		return null
	}
}

function withMcpOAuthTransportFetch<T extends Record<string, unknown>>(
	transport: T,
): T {
	const authProvider = transport['authProvider'] as
		| { coalesceFetch?: typeof fetch }
		| undefined
	const coalesceFetch = authProvider?.coalesceFetch
	if (!coalesceFetch || transport['fetch']) return transport
	return { ...transport, fetch: coalesceFetch }
}

export function isRecoverableMcpOAuthStateError(error: string | null) {
	if (!error) return false
	const normalized = error.toLowerCase()
	return (
		normalized.includes('state not found') ||
		normalized.includes('already used') ||
		normalized.includes('state expired') ||
		normalized.includes('invalid state') ||
		normalized.includes('no state provided')
	)
}

/**
 * Per-user Durable Object that owns the Agents SDK `MCPClientManager` for all
 * of that user's remote MCP servers. The DO id is derived from the stable MCP
 * `userId` (see `mcp-client-hub-key.ts` helpers in `hub-client.ts`), so
 * connections, OAuth client registrations, and tokens are isolated per user
 * inside this object's storage.
 */
class McpClientHubBase extends DurableObject<Env> {
	private readonly manager: MCPClientManager
	private readonly lifecycle: Lifecycle<Env>
	private restored: Promise<void> | null = null
	private operationallyRestored = false
	private readonly lastDiscoverErrors = new Map<string, McpServerLastError>()
	private readonly tokenPresence = new Map<string, McpOAuthTokenPresence>()
	private readonly connectLocks = new Map<string, Promise<void>>()
	/** Why the last connect attempt failed; the SDK returns it but keeps none. */
	private readonly connectErrors = new Map<string, string>()
	private readonly preRegisteredClients = new Map<
		string,
		Promise<McpPreRegisteredOAuthClientInformation | null>
	>()
	/** Public ids of stored pre-registered clients, for snapshots. */
	private readonly preRegisteredClientIds = new Map<string, string>()
	private readonly oauthClientChangeLocks = new Map<string, Promise<void>>()

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		// The manager creates this table during lifecycle start, but
		// `sanitizeStoredMcpSessions` reads it before start so the table must
		// exist first.
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
				id TEXT PRIMARY KEY NOT NULL,
				name TEXT NOT NULL,
				server_url TEXT NOT NULL,
				callback_url TEXT NOT NULL,
				client_id TEXT,
				auth_url TEXT,
				server_options TEXT
			)
		`)
		// createAuthProvider mirrors Agent.addMcpServer so restore + OAuth
		// callback paths rebuild a DO-storage-backed provider after hibernation.
		this.manager = new MCPClientManager(mcpClientName, mcpClientVersion, {
			createAuthProvider: (callbackUrl) => this.createAuthProvider(callbackUrl),
		})
		// Restore rebuilds the auth provider but not transport.fetch (functions
		// cannot persist in server_options). Wire coalesceFetch on every
		// createConnection — including hibernation restore — before the
		// StreamableHTTP/SSE transport captures fetch at construction.
		// MCPClientManager.createConnection is private; patch through a narrow
		// escape hatch so restore gets the same fetch wiring as registerServer.
		type McpCreateConnection = (
			id: string,
			url: string,
			options: {
				client?: unknown
				transport?: Record<string, unknown>
				discoverResult?: unknown
			},
		) => unknown
		const managerWithCreate = this.manager as unknown as {
			createConnection?: McpCreateConnection
		}
		const createConnection = managerWithCreate.createConnection
		if (typeof createConnection === 'function') {
			const boundCreateConnection = createConnection.bind(managerWithCreate)
			managerWithCreate.createConnection = (id, url, options) => {
				const transport = options.transport
				if (!transport) return boundCreateConnection(id, url, options)
				return boundCreateConnection(id, url, {
					...options,
					transport: withMcpOAuthTransportFetch(transport),
				})
			}
		}
		// The manager is a lifecycle capability: it receives DO storage from the
		// lifecycle and restores persisted connections in its `onStart`.
		this.lifecycle = Lifecycle.install(this).use(this.manager)
	}

	private createAuthProvider(callbackUrl: string) {
		return createMcpClientOAuthProvider(this.ctx.storage, callbackUrl, {
			resolvePreRegisteredClient: (serverId) =>
				this.resolvePreRegisteredOAuthClient(serverId),
			resolveLiveServerIdentity: (serverId) =>
				this.resolveLiveOAuthServerIdentity(serverId),
		})
	}

	/**
	 * Request-scoped OAuth actor. Durable Object I/O can interleave RPCs, so
	 * this must not be instance state; AsyncLocalStorage keeps each RPC's
	 * ownerOrgId/personId through awaits without leaking to siblings.
	 */
	private static readonly oauthActorStorage =
		new AsyncLocalStorage<McpOAuthAttemptActor | null>()

	private withOAuthActor<T>(
		actor: McpOAuthAttemptActor | null | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		const normalized =
			actor?.ownerOrgId?.trim() && actor.personId?.trim()
				? {
						ownerOrgId: actor.ownerOrgId.trim(),
						personId: actor.personId.trim(),
					}
				: null
		return McpClientHubBase.oauthActorStorage.run(normalized, run)
	}

	private currentOAuthActor() {
		return McpClientHubBase.oauthActorStorage.getStore() ?? null
	}

	/**
	 * Live hub row + expected OAuth client for an in-flight attempt fence.
	 * Pre-registered clients win over SQL `client_id` (DCR/CIMD), matching how
	 * the provider presents credentials to the authorization server. Owner org
	 * and person come from the current RPC actor (add/reconnect/consent/callback).
	 */
	private async resolveLiveOAuthServerIdentity(serverId: string) {
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		if (!row) return null
		let preRegisteredClientId =
			this.preRegisteredClientIds.get(serverId) ?? null
		if (!preRegisteredClientId) {
			const sealed = await this.readSealedPreRegisteredOAuthClient(serverId)
			if (sealed) {
				preRegisteredClientId = sealed.clientId
				this.preRegisteredClientIds.set(serverId, sealed.clientId)
			}
		}
		const authUrlClientId = clientIdFromStoredAuthUrl(row.auth_url)
		const actor = this.currentOAuthActor()
		return {
			serverId: row.id,
			serverUrl: row.server_url,
			clientId: preRegisteredClientId ?? row.client_id ?? authUrlClientId,
			ownerOrgId: actor?.ownerOrgId ?? null,
			personId: actor?.personId ?? null,
			name: row.name,
		}
	}

	/**
	 * Consent Continue rebinds the pending attempt to the person who approved
	 * leaving Kody for the provider, so a different org admin can finish the
	 * flow without failing the person-id fence.
	 */
	async bindOAuthAttemptActor(input: {
		serverId: string
		actor: McpOAuthAttemptActor
	}): Promise<{ ok: boolean }> {
		await this.ensureRestored()
		return this.withOAuthActor(input.actor, async () => {
			const pending = await readMcpOAuthAttemptIdentity(
				this.ctx.storage,
				input.serverId,
			)
			const actor = this.currentOAuthActor()
			if (!pending || !actor) return { ok: false }
			if (pending.ownerOrgId !== actor.ownerOrgId) {
				return { ok: false }
			}
			await writeMcpOAuthAttemptIdentity(this.ctx.storage, {
				...pending,
				personId: actor.personId,
			})
			return { ok: true }
		})
	}

	private async readSealedPreRegisteredOAuthClient(serverId: string) {
		return parseSealedMcpPreRegisteredOAuthClient(
			await this.ctx.storage.get(
				mcpPreRegisteredOAuthClientStorageKey(serverId),
			),
		)
	}

	private resolvePreRegisteredOAuthClient(serverId: string) {
		const cached = this.preRegisteredClients.get(serverId)
		if (cached) return cached
		const pending = (async () => {
			const sealed = await this.readSealedPreRegisteredOAuthClient(serverId)
			if (!sealed) return null
			return {
				client_id: sealed.clientId,
				client_secret: await decryptMcpServerOAuthClientSecret(
					this.env,
					sealed.sealedClientSecret,
					mcpServerOAuthClientSecretContext(serverId),
				),
			}
		})()
		pending.catch(() => this.preRegisteredClients.delete(serverId))
		this.preRegisteredClients.set(serverId, pending)
		return pending
	}

	private ensureRestored() {
		this.restored ??= this.restoreSanitizedConnections()
		return this.restored
	}

	/**
	 * RPC methods bypass `fetch`, so start the lifecycle explicitly. Stale
	 * sessions are dropped first because start restores connections.
	 */
	private async restoreSanitizedConnections() {
		sanitizeStoredMcpSessions(this.ctx.storage, {
			keepLegacyHandshakeIds: await this.readLegacyHandshakeServerIds(),
		})
		// Hydrate before start so restore-time token refresh sees pre-registered
		// client ids when fencing an in-flight or refreshed grant.
		await this.hydratePreRegisteredClientIds()
		await this.lifecycle.start()
		await this.hydrateTokenRecoveryErrors()
		this.operationallyRestored = true
	}

	private async hydratePreRegisteredClientIds() {
		const entries = await this.ctx.storage.list({
			prefix: mcpPreRegisteredOAuthClientStoragePrefix,
		})
		for (const [key, value] of entries) {
			const sealed = parseSealedMcpPreRegisteredOAuthClient(value)
			if (!sealed) continue
			this.preRegisteredClientIds.set(
				key.slice(mcpPreRegisteredOAuthClientStoragePrefix.length),
				sealed.clientId,
			)
		}
	}

	private async readLegacyHandshakeServerIds() {
		const entries = await this.ctx.storage.list({
			prefix: mcpLegacyHandshakeStoragePrefix,
		})
		return new Set(
			[...entries.keys()].map((key) =>
				key.slice(mcpLegacyHandshakeStoragePrefix.length),
			),
		)
	}

	private async rememberLegacyHandshakeFallback(serverId: string) {
		await this.ctx.storage.put(
			mcpLegacyHandshakeStorageKey(serverId),
			mcpLegacyHandshakeFallback,
		)
	}

	private async rememberLegacyHandshakeIfActive(serverId: string) {
		if (
			readMcpVersionNegotiationMode(
				this.manager.mcpConnections[serverId]?.options.client,
			) !== 'legacy'
		) {
			return
		}
		await this.rememberLegacyHandshakeFallback(serverId)
	}

	private async forgetLegacyHandshakeFallback(serverId: string) {
		await this.ctx.storage.delete(mcpLegacyHandshakeStorageKey(serverId))
	}

	private clearSessionBeforeConnect(serverId: string) {
		const connection = this.manager.mcpConnections[serverId]
		if (connection) clearLiveMcpTransportSession(connection)
	}

	private connectionStateFor(serverId: string): McpServerConnectionState {
		const connection = this.manager.mcpConnections[serverId]
		if (!connection) return 'disconnected'
		return connection.connectionState
	}

	private buildServerSnapshot(row: {
		id: string
		name: string
		server_url: string
		auth_url: string | null
	}): McpHubServerSnapshot {
		const connection = this.manager.mcpConnections[row.id]
		const state = this.connectionStateFor(row.id)
		const tools: McpHubServerSnapshot['tools'] =
			connection && state === 'ready'
				? connection.tools.map((tool) => ({
						name: tool.name,
						...(tool.title ? { title: tool.title } : {}),
						...(tool.description ? { description: tool.description } : {}),
						// Agents exposes a looser JSON-Schema-like inference than
						// JSONSchema7 / Tool['inputSchema']; values are plain JSON Schema.
						inputSchema:
							tool.inputSchema as McpServerToolDescriptor['inputSchema'],
						...(tool.outputSchema
							? {
									outputSchema:
										tool.outputSchema as McpServerToolDescriptor['outputSchema'],
								}
							: {}),
						...(tool.annotations ? { annotations: tool.annotations } : {}),
					}))
				: []
		const lastError = this.lastDiscoverErrors.get(row.id) ?? null
		const error =
			connection?.connectionError ??
			lastError?.message ??
			(state === 'failed' ? (this.connectErrors.get(row.id) ?? null) : null)
		return {
			serverId: row.id,
			name: row.name,
			url: row.server_url,
			state,
			authUrl: row.auth_url,
			error,
			lastError,
			hasRefreshToken: this.tokenPresence.get(row.id)?.hasRefreshToken ?? false,
			instructions: connection?.instructions ?? null,
			tools,
			oauthClientId: this.preRegisteredClientIds.get(row.id) ?? null,
		}
	}

	private buildConnectResult(serverId: string): McpHubConnectResult {
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		const snapshot = row
			? this.buildServerSnapshot(row)
			: {
					state: this.connectionStateFor(serverId),
					authUrl: null,
					error: null,
					lastError: this.lastDiscoverErrors.get(serverId) ?? null,
					hasRefreshToken:
						this.tokenPresence.get(serverId)?.hasRefreshToken ?? false,
					tools: [],
				}
		return {
			serverId,
			state: snapshot.state,
			authUrl: snapshot.authUrl,
			error: snapshot.error,
			toolCount: snapshot.tools.length,
			lastError: snapshot.lastError ?? null,
			hasRefreshToken: snapshot.hasRefreshToken ?? false,
		}
	}

	/**
	 * Register a server and start connecting. For OAuth-protected servers the
	 * result is `state: "authenticating"` with an `authUrl` the user must
	 * open; `handleOAuthCallback` completes the flow.
	 */
	async addServer(input: {
		serverId: string
		name: string
		url: string
		callbackUrl: string
		actor?: McpOAuthAttemptActor | null
		/**
		 * Optional static request headers (for example Authorization: Bearer …).
		 * Persisted in the Agents SDK `server_options` blob alongside the server
		 * row; never returned in snapshots.
		 */
		headers?: Record<string, string>
	}): Promise<McpHubConnectResult> {
		await this.ensureRestored()
		return this.withOAuthActor(input.actor, async () => {
			await this.forgetLegacyHandshakeFallback(input.serverId)
			this.clearIncompleteDiscoverStamp(input.serverId)
			this.tokenPresence.delete(input.serverId)
			await this.persistTokenRecoveryLastError(input.serverId, null)
			const existing = this.manager.mcpConnections[input.serverId]
			if (existing) {
				await this.manager.removeServer(input.serverId)
			}
			// `registerServer` does not create an OAuth provider on its own (the SDK
			// Agent class builds one in `addMcpServer`), so build the same
			// DO-storage-backed provider here or OAuth servers can never surface an
			// authorization URL. The clientName must match the one passed to
			// `restoreConnectionsFromStorage` so storage keys line up after restarts.
			const authProvider = this.createAuthProvider(input.callbackUrl)
			authProvider.serverId = input.serverId
			await this.manager.registerServer(input.serverId, {
				url: input.url,
				name: input.name,
				callbackUrl: input.callbackUrl,
				client: outboundMcpClientOptions(),
				transport: withStaticTransportHeaders(
					withMcpOAuthTransportFetch({
						type: 'auto' as const,
						authProvider,
						...(input.headers ? { headers: input.headers } : {}),
					}),
				),
			})
			this.clearSessionBeforeConnect(input.serverId)
			const connected = await this.connectToServerSerialized(input.serverId)
			if (connected.state === 'connected') {
				await this.runDiscoverIfConnected(input.serverId)
			}
			await this.observeServer({
				serverId: input.serverId,
				serverName: input.name,
			})
			return this.finalizeConnectResult(input.serverId)
		})
	}

	/**
	 * Restart a saved server with the deployment's current OAuth callback.
	 *
	 * Re-registering the local connection clears pending state and PKCE values,
	 * so every reconnect gets a fresh authorization URL. A callback change also
	 * drops the stored dynamic client registration, forcing DCR to advertise the
	 * current redirect URI while preserving the saved server row in D1.
	 */
	async reconnectServer(input: {
		serverId: string
		callbackUrl: string
		actor?: McpOAuthAttemptActor | null
	}): Promise<McpHubConnectResult> {
		await this.ensureRestored()
		return this.withOAuthActor(input.actor, async () => {
			await this.manager.waitForConnections({
				timeout: connectionSettleTimeoutMs,
			})
			await this.forgetLegacyHandshakeFallback(input.serverId)
			await this.restartServerAuthorization(input)
			const row = this.manager
				.listServers()
				.find((server) => server.id === input.serverId)
			if (row) {
				await this.observeServer({
					serverId: row.id,
					serverName: row.name,
				})
			}
			return this.finalizeConnectResult(input.serverId)
		})
	}

	/** Re-discover tools for a connected server. */
	async refreshServer(input: {
		serverId: string
	}): Promise<McpHubConnectResult> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		const before = await this.readTokenPresence(input.serverId)
		await this.runDiscoverIfConnected(input.serverId)
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (row) {
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
		}
		return await this.finishConnectResult(input.serverId, before)
	}

	async removeServer(input: { serverId: string }): Promise<void> {
		await this.ensureRestored()
		await this.manager.removeServer(input.serverId)
		this.lastDiscoverErrors.delete(input.serverId)
		this.tokenPresence.delete(input.serverId)
		this.connectErrors.delete(input.serverId)
		this.preRegisteredClients.delete(input.serverId)
		this.preRegisteredClientIds.delete(input.serverId)
		await this.ctx.storage.delete([
			mcpConnectionEpisodeStorageKey(input.serverId),
			mcpLegacyHandshakeStorageKey(input.serverId),
			mcpOAuthTokenRecoveryStorageKey(input.serverId),
			mcpOAuthRefreshTokenStorageKey(input.serverId),
			mcpOAuthRefreshGrantOmittedStorageKey(input.serverId),
			mcpPreRegisteredOAuthClientStorageKey(input.serverId),
			mcpOAuthAttemptStorageKey(input.serverId),
			mcpOAuthAttemptVerifiedStorageKey(input.serverId),
		])
	}

	/**
	 * Save or clear a server's pre-registered OAuth client, then start a
	 * fresh authorization with it. The worker seals the secret before it gets
	 * here. Tokens and any CIMD or DCR registration from the previous client
	 * are dropped because the authorization server issued them to that
	 * client, so once the new client is stored the change is committed: a
	 * failed restart is reported on the server instead of rolled back.
	 * Changes to one server run one at a time.
	 */
	async setPreRegisteredOAuthClient(input: {
		serverId: string
		callbackUrl: string
		client: SealedMcpPreRegisteredOAuthClient | null
		actor?: McpOAuthAttemptActor | null
	}): Promise<McpHubOAuthClientChange> {
		await this.ensureRestored()
		return this.withOAuthActor(input.actor, async () =>
			this.serializeOAuthClientChange(input.serverId, async () => {
				const row = this.manager
					.listServers()
					.find((server) => server.id === input.serverId)
				if (!row) {
					throw new Error(`MCP server "${input.serverId}" is not registered.`)
				}
				const previousClientId =
					this.preRegisteredClientIds.get(input.serverId) ?? null
				if (!input.client && !previousClientId) {
					return {
						changed: false,
						previousClientId,
						connection: this.finalizeConnectResult(input.serverId),
					}
				}
				await this.manager.waitForConnections({
					timeout: connectionSettleTimeoutMs,
				})
				const key = mcpPreRegisteredOAuthClientStorageKey(input.serverId)
				if (input.client) {
					await this.ctx.storage.put(key, input.client)
					this.preRegisteredClientIds.set(input.serverId, input.client.clientId)
				} else {
					await this.ctx.storage.delete(key)
					this.preRegisteredClientIds.delete(input.serverId)
				}
				this.preRegisteredClients.delete(input.serverId)
				this.tokenPresence.delete(input.serverId)
				this.lastDiscoverErrors.delete(input.serverId)
				// A new client means a new grant: start a fresh connection episode
				// so the parked approval is not read as a failed token refresh.
				await this.ctx.storage.delete(
					mcpConnectionEpisodeStorageKey(input.serverId),
				)
				await this.persistTokenRecoveryLastError(input.serverId, null)
				await this.forgetLegacyHandshakeFallback(input.serverId)
				try {
					await this.restartServerAuthorization({
						serverId: input.serverId,
						callbackUrl: input.callbackUrl,
						resetClientRegistration: true,
					})
				} catch (error) {
					const reason = (
						error instanceof Error ? error.message : String(error)
					).replace(/\.$/, '')
					this.lastDiscoverErrors.set(input.serverId, {
						message: input.client
							? `The OAuth client was saved, but Kody could not start authorization with it (${reason}). Reconnect the server to try again.`
							: `The OAuth client was removed, but Kody could not start authorization without it (${reason}). Reconnect the server to try again.`,
						phase: null,
						httpStatus: null,
						httpBodySnippet: null,
						mcpEndpoint: sanitizePublicUrl(row.server_url),
						resource: null,
						authServer: null,
						attemptId: crypto.randomUUID(),
						at: new Date().toISOString(),
					})
				}
				await this.observeServer({ serverId: row.id, serverName: row.name })
				return {
					changed: true,
					previousClientId,
					connection: this.finalizeConnectResult(input.serverId),
				}
			}),
		)
	}

	private async serializeOAuthClientChange<T>(
		serverId: string,
		run: () => Promise<T>,
	): Promise<T> {
		const previous = this.oauthClientChangeLocks.get(serverId)
		let release = () => {}
		const current = new Promise<void>((resolve) => {
			release = resolve
		})
		this.oauthClientChangeLocks.set(serverId, current)
		await previous
		try {
			return await run()
		} finally {
			release()
			if (this.oauthClientChangeLocks.get(serverId) === current) {
				this.oauthClientChangeLocks.delete(serverId)
			}
		}
	}

	/**
	 * The provider authorization URL for a server parked on `authenticating`,
	 * with what the consent page shows about it. Null when nothing is waiting
	 * for approval. The consent page's Continue is the only caller.
	 */
	async readPendingAuthorization(input: {
		serverId: string
	}): Promise<McpServerPendingAuthorization | null> {
		await this.ensureRestored()
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (!row?.auth_url || !URL.canParse(row.auth_url)) return null
		if (this.connectionStateFor(row.id) !== 'authenticating') return null
		const preRegistered = await this.readSealedPreRegisteredOAuthClient(row.id)
		return {
			serverId: row.id,
			name: row.name,
			serverUrl: row.server_url,
			authorizationUrl: row.auth_url,
			clientMode: resolveMcpOAuthClientMode({
				authorizationUrl: row.auth_url,
				callbackUrl: row.callback_url,
				preRegisteredClientId: preRegistered?.clientId ?? null,
			}),
		}
	}

	/**
	 * Complete an OAuth authorization redirect. The worker forwards the
	 * callback URL (including `code` and `state`) after authenticating the
	 * browser session that owns this hub.
	 *
	 * Success is reported only when the MCP connection reaches `ready`. The
	 * Agents SDK `authSuccess` flag alone is not enough: it can clear the
	 * stored auth URL and leave the connection in `authenticating` with no
	 * error after a provider (e.g. Clerk) authorization redirect.
	 */
	async handleOAuthCallback(input: {
		url: string
		callbackUrl: string
		actor?: McpOAuthAttemptActor | null
	}): Promise<McpServerOAuthCallbackOutcome> {
		await this.ensureRestored()
		return this.withOAuthActor(input.actor, async () => {
			const request = new Request(input.url, { method: 'GET' })
			const stateServerId = extractMcpServerIdFromOAuthState(
				new URL(request.url).searchParams.get('state'),
			)
			if (!this.manager.isCallbackRequest(request)) {
				if (
					stateServerId &&
					this.manager
						.listServers()
						.some((server) => server.id === stateServerId)
				) {
					return await this.restartAfterUnusableCallback({
						serverId: stateServerId,
						callbackUrl: input.callbackUrl,
					})
				}
				const pendingServers = this.manager
					.listServers()
					.filter((server) => Boolean(server.auth_url))
				if (pendingServers.length === 1 && pendingServers[0]) {
					return await this.restartAfterUnusableCallback({
						serverId: pendingServers[0].id,
						callbackUrl: input.callbackUrl,
					})
				}
				return {
					serverId: null,
					authSuccess: false,
					authError: oauthRecoveryMessage,
					serverName: null,
					authorizationNeeded: true,
					lastError: null,
				}
			}
			const result = await this.manager.handleCallbackRequest(request)
			const serverId = result.serverId ?? null
			const serverName = serverId
				? (this.manager.listServers().find((server) => server.id === serverId)
						?.name ?? null)
				: null
			if (
				serverId &&
				!result.authSuccess &&
				isRecoverableMcpOAuthStateError(result.authError ?? null)
			) {
				return await this.restartAfterUnusableCallback({
					serverId,
					callbackUrl: input.callbackUrl,
				})
			}
			if (result.authSuccess && serverId) {
				const settled = await this.settleAfterOAuthGrant(serverId)
				if (serverName) {
					await this.observeServer({
						serverId,
						serverName,
					})
				}
				return await this.resolveOAuthCallbackOutcome({
					sdkAuthSuccess: true,
					sdkAuthError: result.authError ?? null,
					serverId,
					serverName,
					settleError: settled.error,
					settleLastError: settled.lastError ?? null,
				})
			}
			return await this.resolveOAuthCallbackOutcome({
				sdkAuthSuccess: result.authSuccess,
				sdkAuthError: result.authError ?? null,
				serverId,
				serverName,
			})
		})
	}

	private async restartAfterUnusableCallback(input: {
		serverId: string
		callbackUrl: string
	}): Promise<McpServerOAuthCallbackOutcome> {
		const serverName =
			this.manager.listServers().find((server) => server.id === input.serverId)
				?.name ?? null
		const existingConnection = this.buildConnectResult(input.serverId)
		if (existingConnection.state === 'ready') {
			return resolveMcpOAuthCallbackOutcome({
				sdkAuthSuccess: true,
				sdkAuthError: null,
				serverId: input.serverId,
				serverName,
				connection: existingConnection,
			})
		}
		if (
			existingConnection.state === 'connected' ||
			existingConnection.state === 'discovering' ||
			existingConnection.state === 'connecting'
		) {
			// IdP already succeeded. Keep tokens, but do not claim callback
			// success or clear lastError until the connection is ready. A
			// Back/replay after an incomplete settle used to wipe the durable
			// reason and redirect with auth=success.
			let settleError: string | null = null
			let settleLastError: McpServerLastError | null = null
			if (existingConnection.state === 'connected') {
				const discovered = await this.discoverAfterOAuthEstablish(
					input.serverId,
				)
				settleError = discovered.error
				settleLastError = discovered.lastError ?? null
			}
			return await this.resolveOAuthCallbackOutcome({
				sdkAuthSuccess: true,
				sdkAuthError: null,
				serverId: input.serverId,
				serverName,
				settleError,
				settleLastError,
			})
		}
		const storedTokens = await this.readTokenPresence(input.serverId)
		if (shouldAttemptMcpOAuthRefresh(storedTokens)) {
			// A replay/prefetch often arrives after the first GET already
			// exchanged the code. Settle with those tokens instead of
			// reminting — remint used to wipe the new grant and force a
			// second Authorize click.
			const settled = await this.settleAfterOAuthGrant(input.serverId)
			if (serverName) {
				await this.observeServer({
					serverId: input.serverId,
					serverName,
				})
			}
			if (
				settled.state === 'ready' ||
				shouldAttemptMcpOAuthRefresh(
					await this.readTokenPresence(input.serverId),
				)
			) {
				return await this.resolveOAuthCallbackOutcome({
					sdkAuthSuccess: true,
					sdkAuthError: null,
					serverId: input.serverId,
					serverName,
					settleError: settled.error,
					settleLastError: settled.lastError ?? null,
				})
			}
		}
		try {
			const connection = await this.restartServerAuthorization(input)
			if (connection.state === 'ready') {
				return {
					serverId: input.serverId,
					authSuccess: true,
					authError: null,
					serverName,
					authorizationNeeded: false,
					lastError: null,
				}
			}
		} catch {
			// The account page offers Reconnect if automatic recovery fails.
		}
		return {
			serverId: input.serverId,
			authSuccess: false,
			authError: oauthRecoveryMessage,
			serverName,
			authorizationNeeded: true,
			lastError: null,
		}
	}

	private async settleAfterOAuthGrant(
		serverId: string,
	): Promise<McpHubConnectResult> {
		await this.clearTokenRecoveryLastError(serverId)
		this.clearSessionBeforeConnect(serverId)
		await this.manager.establishConnection(serverId)
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		const connection = this.buildConnectResult(serverId)
		if (isStuckMcpAuthenticatingWithoutAuthUrl(connection)) {
			return await this.recoverStuckAuthenticating(serverId)
		}
		if (connection.state === 'connected') {
			return await this.discoverAfterOAuthEstablish(serverId)
		}
		return connection
	}

	private async restartServerAuthorization(input: {
		serverId: string
		callbackUrl: string
		/** Drop the stored client registration and tokens, as for a new client. */
		resetClientRegistration?: boolean
	}): Promise<McpHubConnectResult> {
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (!row) {
			throw new Error(`MCP server "${input.serverId}" is not registered.`)
		}

		const storedTokens = await this.readTokenPresence(input.serverId)
		if (
			!input.resetClientRegistration &&
			row.callback_url === input.callbackUrl &&
			shouldAttemptMcpOAuthRefresh(storedTokens)
		) {
			const refreshed = await this.connectUsingStoredOAuthTokens(input.serverId)
			if (refreshed.state === 'ready') {
				return refreshed
			}
			if (refreshed.state === 'authenticating' && refreshed.authUrl) {
				return refreshed
			}
			// Authenticated but discovery incomplete: keep tokens. Reminting
			// would force consent for a tools/list timeout.
			if (refreshed.state === 'connected') {
				return refreshed
			}
			// authenticating without authUrl (or failed) while tokens remain:
			// fall through to remint so the user can re-approve. Do not treat
			// leftover tokens alone as a reason to return a stuck snapshot.
			const presenceAfter = await this.readTokenPresence(input.serverId)
			if (
				refreshed.state !== 'authenticating' &&
				refreshed.state !== 'failed' &&
				shouldAttemptMcpOAuthRefresh(presenceAfter)
			) {
				return refreshed
			}
		}

		const existingConnection = this.manager.mcpConnections[input.serverId]
		const existingOptions = existingConnection?.options
		const clearClientRegistration =
			input.resetClientRegistration === true ||
			row.callback_url !== input.callbackUrl
		const clientId = clearClientRegistration ? null : row.client_id
		const oauthStoragePrefix = `/${mcpClientName}/${input.serverId}/`
		const oauthStorageSnapshot = await this.ctx.storage.list({
			prefix: oauthStoragePrefix,
		})
		const sidecarKey = mcpOAuthRefreshTokenStorageKey(input.serverId)
		const sidecarValue = await this.ctx.storage.get(sidecarKey)
		if (sidecarValue !== undefined) {
			oauthStorageSnapshot.set(sidecarKey, sidecarValue)
		}
		const omittedKey = mcpOAuthRefreshGrantOmittedStorageKey(input.serverId)
		const omittedValue = await this.ctx.storage.get(omittedKey)
		if (omittedValue !== undefined) {
			oauthStorageSnapshot.set(omittedKey, omittedValue)
		}
		const attemptKey = mcpOAuthAttemptStorageKey(input.serverId)
		const attemptValue = await this.ctx.storage.get(attemptKey)
		if (attemptValue !== undefined) {
			oauthStorageSnapshot.set(attemptKey, attemptValue)
		}
		const attemptVerifiedKey = mcpOAuthAttemptVerifiedStorageKey(input.serverId)
		const attemptVerifiedValue = await this.ctx.storage.get(attemptVerifiedKey)
		if (attemptVerifiedValue !== undefined) {
			oauthStorageSnapshot.set(attemptVerifiedKey, attemptVerifiedValue)
		}

		// Read presence before removeServer: tokens() lives on the connection's
		// authProvider, so a post-remove read always looks empty and would wipe
		// a leftover refresh token during remint.
		const presenceBeforeRemint = await this.readTokenPresence(input.serverId)
		try {
			await this.manager.removeServer(input.serverId)
			// Remint for a replacement authorization. Clear token blobs only when
			// resetting the client registration, or when no usable grant remains.
			// Do not wipe a live refresh token after a discovery-only failure —
			// that path returns above. Sibling blobs clear on authorization-code
			// saveTokens after redirect, not on redirect itself.
			await this.clearOAuthAuthorizationStorage({
				serverId: input.serverId,
				clearClientRegistration,
				clearTokens:
					clearClientRegistration ||
					!shouldAttemptMcpOAuthRefresh(presenceBeforeRemint),
			})

			const authProvider = this.createAuthProvider(input.callbackUrl)
			authProvider.serverId = input.serverId
			if (clientId) authProvider.clientId = clientId

			const reconnected = reconnectMcpServerOptions(existingOptions)
			await this.manager.registerServer(input.serverId, {
				url: row.server_url,
				name: row.name,
				callbackUrl: input.callbackUrl,
				...(clientId ? { clientId } : {}),
				client: reconnected.client,
				transport: withStaticTransportHeaders(
					withMcpOAuthTransportFetch({
						...reconnected.transport,
						type: reconnected.transport.type ?? 'auto',
						authProvider,
					}),
				),
			})
		} catch (error) {
			await this.manager.removeServer(input.serverId).catch(() => {})
			if (input.resetClientRegistration) {
				// The old tokens and registration belong to the replaced client,
				// so keep the server registered without them.
				const freshAuthProvider = this.createAuthProvider(input.callbackUrl)
				freshAuthProvider.serverId = input.serverId
				const fresh = reconnectMcpServerOptions(existingOptions)
				await this.manager
					.registerServer(input.serverId, {
						url: row.server_url,
						name: row.name,
						callbackUrl: input.callbackUrl,
						client: fresh.client,
						transport: withStaticTransportHeaders(
							withMcpOAuthTransportFetch({
								...fresh.transport,
								type: fresh.transport.type ?? 'auto',
								authProvider: freshAuthProvider,
							}),
						),
					})
					.catch(() => {})
				throw error
			}
			if (oauthStorageSnapshot.size > 0) {
				await this.ctx.storage
					.put(Object.fromEntries(oauthStorageSnapshot))
					.catch(() => {})
			}

			const originalAuthProvider = this.createAuthProvider(row.callback_url)
			originalAuthProvider.serverId = input.serverId
			if (row.client_id) originalAuthProvider.clientId = row.client_id
			const restored = reconnectMcpServerOptions(existingOptions)
			await this.manager
				.registerServer(input.serverId, {
					url: row.server_url,
					name: row.name,
					callbackUrl: row.callback_url,
					...(row.client_id ? { clientId: row.client_id } : {}),
					...(row.auth_url ? { authUrl: row.auth_url } : {}),
					client: restored.client,
					transport: withStaticTransportHeaders(
						withMcpOAuthTransportFetch({
							...restored.transport,
							type: restored.transport.type ?? 'auto',
							authProvider: originalAuthProvider,
						}),
					),
				})
				.catch(() => {})
			throw error
		}
		this.clearSessionBeforeConnect(input.serverId)
		const result = await this.connectToServerSerialized(input.serverId)
		if (result.state === 'connected') {
			return (await this.runDiscoverIfConnected(input.serverId)).result
		}
		if (input.resetClientRegistration) {
			// A deliberate client reset signs out the old grant; it is not a
			// failed token refresh, so skip token-recovery stamping.
			await this.readTokenPresence(input.serverId)
			return this.finalizeConnectResult(input.serverId)
		}
		return await this.finishConnectResult(input.serverId, storedTokens)
	}

	private async clearOAuthAuthorizationStorage(input: {
		serverId: string
		clearClientRegistration: boolean
		/**
		 * Drop `/token` blobs and the refresh-token sidecar. Remint and
		 * re-authorize use this so a leftover DCR key cannot shadow a new
		 * CIMD grant. Refresh-first reconnect keeps tokens (false).
		 */
		clearTokens?: boolean
	}) {
		const clearTokens =
			input.clearClientRegistration || input.clearTokens === true
		const prefix = `/${mcpClientName}/${input.serverId}/`
		const entries = await this.ctx.storage.list({ prefix })
		const keys = [...entries.keys()].filter((key) => {
			if (input.clearClientRegistration) return true
			if (key.endsWith('/token')) return clearTokens
			return !key.endsWith('/client_info/') && !key.endsWith('/oauth_discovery')
		})
		if (clearTokens) {
			keys.push(
				mcpOAuthRefreshTokenStorageKey(input.serverId),
				mcpOAuthRefreshGrantOmittedStorageKey(input.serverId),
			)
		}
		// A reconnect or client reset retires any in-flight attempt identity.
		keys.push(
			mcpOAuthAttemptStorageKey(input.serverId),
			mcpOAuthAttemptVerifiedStorageKey(input.serverId),
		)
		if (keys.length > 0) {
			await this.ctx.storage.delete(keys)
		}
	}

	/**
	 * Clear unusable tokens and reconnect so the Agents SDK can mint a fresh
	 * auth URL. Needed when SQL `auth_url` was cleared on callback success but
	 * the live connection never reached `ready`.
	 */
	private clearIncompleteDiscoverStamp(
		serverId: string,
		options?: { preserveTokenRecovery?: boolean },
	) {
		const existing = this.lastDiscoverErrors.get(serverId) ?? null
		if (
			options?.preserveTokenRecovery &&
			isMcpOAuthGrantIssueLastError(existing)
		) {
			return
		}
		if (isMcpOAuthMissingRefreshGrantLastError(existing)) {
			return
		}
		const connection = this.manager.mcpConnections[serverId]
		if (connection) connection.connectionError = null
		this.lastDiscoverErrors.delete(serverId)
	}

	private async runDiscoverIfConnected(
		serverId: string,
		options?: { allowLegacyFallback?: boolean; attemptId?: string | null },
	): Promise<{
		result: McpHubConnectResult
		lastError: McpServerLastError | null
	}> {
		this.clearIncompleteDiscoverStamp(serverId, {
			preserveTokenRecovery: true,
		})
		let discoverError: string | null = null
		try {
			await this.manager.discoverIfConnected(serverId, {
				timeoutMs: discoverTimeoutMs,
			})
		} catch (error) {
			discoverError = error instanceof Error ? error.message : String(error)
		}
		const afterAuto = this.applyIncompleteDiscoverFailure(
			serverId,
			discoverError,
			{
				catalogAttempted: true,
				attemptId: options?.attemptId,
			},
		)
		const outcome =
			options?.allowLegacyFallback === false ||
			!shouldRetryLegacyHandshake({
				state: afterAuto.result.state,
				client: this.manager.mcpConnections[serverId]?.options.client,
			})
				? afterAuto
				: await this.retryDiscoverWithLegacyHandshake(serverId, afterAuto)
		if (outcome.result.state === 'ready') {
			await this.stampMissingRefreshGrantIfReady(serverId)
		}
		return outcome
	}

	private async retryDiscoverWithLegacyHandshake(
		serverId: string,
		autoFailure: {
			result: McpHubConnectResult
			lastError: McpServerLastError | null
		},
	): Promise<{
		result: McpHubConnectResult
		lastError: McpServerLastError | null
	}> {
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		const existingOptions = this.manager.mcpConnections[serverId]?.options
		if (!row || !existingOptions) {
			return this.keepCatalogLastError(serverId, autoFailure, null)
		}

		console.warn('mcp discover retrying legacy handshake', {
			serverId,
			attemptId: autoFailure.lastError?.attemptId ?? null,
			mcpEndpoint: sanitizePublicUrl(row.server_url),
		})

		try {
			await this.manager.removeServer(serverId)
			const authProvider = this.createAuthProvider(row.callback_url)
			authProvider.serverId = serverId
			if (row.client_id) authProvider.clientId = row.client_id
			const legacy = reconnectMcpServerOptions(existingOptions, 'legacy')
			await this.manager.registerServer(serverId, {
				url: row.server_url,
				name: row.name,
				callbackUrl: row.callback_url,
				...(row.client_id ? { clientId: row.client_id } : {}),
				client: legacy.client,
				transport: withStaticTransportHeaders(
					withMcpOAuthTransportFetch({
						...legacy.transport,
						type: legacy.transport.type ?? 'auto',
						authProvider,
					}),
				),
			})
		} catch (error) {
			try {
				await this.manager.removeServer(serverId).catch(() => {})
				const authProvider = this.createAuthProvider(row.callback_url)
				authProvider.serverId = serverId
				if (row.client_id) authProvider.clientId = row.client_id
				const restored = reconnectMcpServerOptions(existingOptions)
				await this.manager.registerServer(serverId, {
					url: row.server_url,
					name: row.name,
					callbackUrl: row.callback_url,
					...(row.client_id ? { clientId: row.client_id } : {}),
					client: restored.client,
					transport: withStaticTransportHeaders(
						withMcpOAuthTransportFetch({
							...restored.transport,
							type: restored.transport.type ?? 'auto',
							authProvider,
						}),
					),
				})
			} catch {
				// The incomplete auto discover lastError is the user-visible outcome.
			}
			return this.keepCatalogLastError(
				serverId,
				autoFailure,
				error instanceof Error ? error.message : String(error),
			)
		}

		this.clearSessionBeforeConnect(serverId)
		const connected = await this.connectToServerSerialized(serverId)
		if (connected.state !== 'connected') {
			const result = await this.finishConnectResult(serverId)
			if (result.state === 'authenticating' && result.authUrl) {
				await this.rememberLegacyHandshakeIfActive(serverId)
				return { result, lastError: result.lastError ?? null }
			}
			return this.keepCatalogLastError(serverId, autoFailure, result.error)
		}
		const discovered = await this.runDiscoverIfConnected(serverId, {
			allowLegacyFallback: false,
			attemptId: autoFailure.lastError?.attemptId,
		})
		if (discovered.result.state === 'ready') {
			await this.rememberLegacyHandshakeIfActive(serverId)
		}
		return discovered
	}

	private keepCatalogLastError(
		serverId: string,
		autoFailure: {
			result: McpHubConnectResult
			lastError: McpServerLastError | null
		},
		discoverError: string | null,
	): {
		result: McpHubConnectResult
		lastError: McpServerLastError | null
	} {
		const stamped = this.applyIncompleteDiscoverFailure(
			serverId,
			discoverError,
			{
				catalogAttempted: true,
				attemptId: autoFailure.lastError?.attemptId,
			},
		)
		if (stamped.lastError) return stamped
		const lastError = autoFailure.lastError
		if (!lastError) return stamped
		const connection = this.manager.mcpConnections[serverId]
		if (connection) connection.connectionError = lastError.message
		this.lastDiscoverErrors.set(serverId, lastError)
		return {
			result: {
				...this.buildConnectResult(serverId),
				error: lastError.message,
				lastError,
			},
			lastError,
		}
	}

	private finalizeConnectResult(serverId: string): McpHubConnectResult {
		return this.applyIncompleteDiscoverFailure(serverId, null).result
	}

	private applyIncompleteDiscoverFailure(
		serverId: string,
		discoverError: string | null,
		options?: { catalogAttempted?: boolean; attemptId?: string | null },
	): {
		result: McpHubConnectResult
		lastError: McpServerLastError | null
	} {
		const result = this.buildConnectResult(serverId)
		const connection = this.manager.mcpConnections[serverId]
		if (!isIncompleteDiscoverState(result.state)) {
			if (result.state === 'ready') {
				const existing = this.lastDiscoverErrors.get(serverId) ?? null
				if (isMcpOAuthMissingRefreshGrantLastError(existing)) {
					return {
						result: {
							...this.buildConnectResult(serverId),
							lastError: existing,
						},
						lastError: existing,
					}
				}
				this.clearIncompleteDiscoverStamp(serverId)
				return {
					result: { ...result, error: null, lastError: null },
					lastError: null,
				}
			}
			const existing = this.lastDiscoverErrors.get(serverId) ?? null
			const existingIsTokenRecovery =
				existing !== null && isMcpOAuthTokenRecoveryLastError(existing)
			if (existing && existingIsTokenRecovery) {
				if (connection) connection.connectionError = existing.message
				return {
					result: {
						...this.buildConnectResult(serverId),
						error: existing.message,
						lastError: existing,
					},
					lastError: existing,
				}
			}
			if (result.state === 'authenticating') {
				this.lastDiscoverErrors.delete(serverId)
				if (connection) connection.connectionError = null
				return {
					result: {
						...result,
						error: null,
						lastError: null,
					},
					lastError: null,
				}
			}
			if (existing) {
				if (connection) connection.connectionError = existing.message
				return {
					result: {
						...this.buildConnectResult(serverId),
						error: existing.message,
						lastError: existing,
					},
					lastError: existing,
				}
			}
			this.lastDiscoverErrors.delete(serverId)
			return {
				result: {
					...result,
					error: result.error ?? discoverError,
					lastError: null,
				},
				lastError: null,
			}
		}

		const alreadyStamped = Boolean(connection?.connectionError)
		if (alreadyStamped && discoverError == null) {
			const existing =
				this.lastDiscoverErrors.get(serverId) ??
				this.rebuildStampedDiscoverLastError(serverId, result, options)
			if (existing) {
				this.lastDiscoverErrors.set(serverId, existing)
				return {
					result: {
						...result,
						error: existing.message,
						lastError: existing,
					},
					lastError: existing,
				}
			}
		}

		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		const lastError = buildIncompleteDiscoverLastError({
			state: result.state,
			authUrl: result.authUrl,
			error: alreadyStamped ? discoverError : (result.error ?? discoverError),
			phase: options?.catalogAttempted ? 'tools/list' : undefined,
			mcpEndpoint: row?.server_url ?? null,
			attemptId: options?.attemptId,
		})
		if (!lastError) {
			return {
				result: {
					...result,
					error: result.error ?? discoverError,
					lastError: null,
				},
				lastError: null,
			}
		}
		if (connection) connection.connectionError = lastError.message
		console.warn('mcp discover timeout incomplete', {
			attemptId: lastError.attemptId,
			serverId,
			phase: lastError.phase,
			state: result.state,
			mcpEndpoint: lastError.mcpEndpoint,
		})
		this.lastDiscoverErrors.set(serverId, lastError)
		return {
			result: {
				...this.buildConnectResult(serverId),
				error: lastError.message,
				lastError,
			},
			lastError,
		}
	}

	private rebuildStampedDiscoverLastError(
		serverId: string,
		result: McpHubConnectResult,
		options?: { catalogAttempted?: boolean; attemptId?: string | null },
	): McpServerLastError | null {
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		return buildIncompleteDiscoverLastError({
			state: result.state,
			authUrl: result.authUrl,
			error: null,
			phase: options?.catalogAttempted ? 'tools/list' : undefined,
			mcpEndpoint: row?.server_url ?? null,
			attemptId:
				options?.attemptId ??
				readAttemptIdFromSettleMessage(result.error) ??
				crypto.randomUUID(),
		})
	}

	private async discoverAfterOAuthEstablish(
		serverId: string,
	): Promise<McpHubConnectResult> {
		const result = (await this.runDiscoverIfConnected(serverId)).result
		if (result.state === 'ready') {
			await this.rememberLegacyHandshakeIfActive(serverId)
			await this.stampMissingRefreshGrantIfReady(serverId)
		}
		return result
	}

	private async resolveOAuthCallbackOutcome(input: {
		sdkAuthSuccess: boolean
		sdkAuthError: string | null
		serverId: string | null
		serverName: string | null
		settleError?: string | null
		settleLastError?: McpServerLastError | null
	}): Promise<McpServerOAuthCallbackOutcome> {
		const connection = input.serverId
			? this.buildConnectResult(input.serverId)
			: null
		const discovery = input.serverId
			? await this.readOAuthDiscoveryUrls(input.serverId)
			: { resource: null, authServer: null }
		const row = input.serverId
			? this.manager
					.listServers()
					.find((server) => server.id === input.serverId)
			: null
		const stamped = input.settleLastError
		const connectionError = connection?.error ?? input.settleError ?? null
		const alreadyFormatted =
			Boolean(stamped) || isFormattedMcpOAuthSettleMessage(connectionError)
		const attemptId =
			stamped?.attemptId ??
			readAttemptIdFromSettleMessage(connectionError) ??
			crypto.randomUUID()
		const outcome = resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: input.sdkAuthSuccess,
			sdkAuthError: input.sdkAuthError,
			serverId: input.serverId,
			serverName: input.serverName,
			attemptId,
			connection: connection
				? {
						...connection,
						error: alreadyFormatted ? null : connectionError,
						phase: stamped?.phase,
						httpStatus: stamped?.httpStatus ?? null,
						httpBodySnippet: stamped?.httpBodySnippet ?? null,
						mcpEndpoint: row?.server_url ?? stamped?.mcpEndpoint ?? null,
						resource: discovery.resource ?? stamped?.resource ?? null,
						authServer: discovery.authServer ?? stamped?.authServer ?? null,
					}
				: null,
		})
		if (outcome.lastError && input.serverId) {
			const live = this.manager.mcpConnections[input.serverId]
			if (live) live.connectionError = outcome.lastError.message
			this.lastDiscoverErrors.set(input.serverId, outcome.lastError)
			console.warn('mcp oauth callback settle incomplete', {
				attemptId: outcome.lastError.attemptId,
				serverId: outcome.serverId,
				phase: outcome.lastError.phase,
				state: connection?.state ?? null,
				httpStatus: outcome.lastError.httpStatus,
				mcpEndpoint: outcome.lastError.mcpEndpoint,
				resource: outcome.lastError.resource,
				authServer: outcome.lastError.authServer,
			})
		}
		return outcome
	}

	private async readOAuthDiscoveryUrls(serverId: string): Promise<{
		resource: string | null
		authServer: string | null
	}> {
		const prefix = `/${mcpClientName}/${serverId}/`
		const entries = await this.ctx.storage.list({ prefix })
		for (const [key, value] of entries) {
			if (
				!key.endsWith('/oauth_discovery') &&
				!key.includes('oauth_discovery')
			) {
				continue
			}
			const parsed = readOAuthDiscoveryUrls(value)
			if (parsed.resource || parsed.authServer) return parsed
		}
		return { resource: null, authServer: null }
	}

	private async recoverStuckAuthenticating(
		serverId: string,
	): Promise<McpHubConnectResult> {
		const storedTokens = await this.readTokenPresence(serverId)
		if (shouldAttemptMcpOAuthRefresh(storedTokens)) {
			const refreshed = await this.connectUsingStoredOAuthTokens(serverId)
			if (refreshed.state === 'ready' || refreshed.authUrl) {
				return refreshed
			}
		}
		const connection = this.manager.mcpConnections[serverId]
		const authProvider = connection?.options.transport.authProvider
		const latestTokens = storedTokens.hasRefreshToken
			? storedTokens
			: await this.readTokenPresence(serverId)
		if (
			!latestTokens.hasRefreshToken &&
			authProvider &&
			typeof authProvider.invalidateCredentials === 'function'
		) {
			try {
				await authProvider.invalidateCredentials('tokens')
			} catch {
				// Best-effort: reconnect below still regenerates OAuth when possible.
			}
		}
		this.clearSessionBeforeConnect(serverId)
		const result = await this.connectToServerSerialized(serverId)
		if (result.state === 'connected') {
			return (await this.runDiscoverIfConnected(serverId)).result
		}
		return await this.finishConnectResult(serverId, storedTokens)
	}

	private async restoreAndWaitForServers() {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
	}

	private listServerCards(): Array<McpHubServerSnapshot> {
		return this.manager
			.listServers()
			.map((row) => this.buildServerSnapshot(row))
	}

	private async collectServerSnapshots(): Promise<Array<McpHubServerSnapshot>> {
		await this.restoreAndWaitForServers()
		for (const row of this.manager.listServers()) {
			const beforeTokens = await this.readTokenPresence(row.id)
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
			await this.finishConnectResult(row.id, beforeTokens)
		}
		return this.listServerCards()
	}

	/** No restore, recovery, token processing, event delivery, or storage writes. */
	async readSnapshot(): Promise<McpClientHubReadSnapshot> {
		if (this.operationallyRestored)
			return projectMcpReadSnapshot(this.listServerCards())
		return coldMcpReadSnapshot(
			await this.ctx.storage.get<McpClientHubReadSnapshot>(
				mcpReadSnapshotStorageKey,
			),
		)
	}

	/** Called by operational clients after writes, including partial failures. */
	async saveReadSnapshot(): Promise<void> {
		if (!this.operationallyRestored) return
		try {
			await this.ctx.storage.put(
				mcpReadSnapshotStorageKey,
				projectMcpReadSnapshot(this.listServerCards()),
			)
		} catch (error) {
			console.warn('mcp-read-snapshot-save-failed', error)
		}
	}

	async getSnapshot(): Promise<McpHubSnapshot> {
		const servers = await this.collectServerSnapshots()
		await this.saveReadSnapshot()
		return {
			servers,
			connectionEvents: await this.peekConnectionEvents(),
		}
	}

	/**
	 * Current server cards without reconnecting. Search waiting uses this
	 * so a cache miss cannot run lightweight reconnect. A token-recovery
	 * park may queue a pending disconnected episode; the hub client
	 * dispatches it after this peek.
	 */
	async peekServers(): Promise<Pick<McpHubSnapshot, 'servers'>> {
		await this.restoreAndWaitForServers()
		for (const row of this.manager.listServers()) {
			const beforeTokens = await this.readTokenPresence(row.id)
			await this.finishConnectResult(row.id, beforeTokens)
		}
		return {
			servers: this.listServerCards(),
		}
	}

	async callTool(input: {
		serverId: string
		toolName: string
		args: Record<string, unknown>
	}): Promise<CallToolResult> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (row) {
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
		}
		const state = this.connectionStateFor(input.serverId)
		if (state !== 'ready') {
			throw new Error(
				`MCP server "${input.serverId}" is not ready (state: ${state}).`,
			)
		}
		return (await this.manager.callTool({
			serverId: input.serverId,
			name: input.toolName,
			arguments: input.args,
		})) as CallToolResult
	}

	async peekConnectionEvents(): Promise<Array<McpServerConnectionEvent>> {
		return (
			(await this.ctx.storage.get<Array<McpServerConnectionEvent>>(
				mcpConnectionEventsPendingStorageKey,
			)) ?? []
		)
	}

	async takeConnectionEvents(): Promise<Array<McpServerConnectionEvent>> {
		const events = await this.peekConnectionEvents()
		if (events.length > 0) {
			await this.ctx.storage.delete(mcpConnectionEventsPendingStorageKey)
		}
		return events
	}

	/**
	 * Remove only the supplied event ids. Events appended while dispatch
	 * was in flight stay pending.
	 */
	async ackConnectionEvents(eventIds: Array<string>): Promise<void> {
		if (eventIds.length === 0) return
		const pending = await this.peekConnectionEvents()
		if (pending.length === 0) return
		const acked = new Set(eventIds)
		const remaining = pending.filter((event) => !acked.has(event.eventId))
		if (remaining.length === pending.length) return
		if (remaining.length === 0) {
			await this.ctx.storage.delete(mcpConnectionEventsPendingStorageKey)
			return
		}
		await this.ctx.storage.put(mcpConnectionEventsPendingStorageKey, remaining)
	}

	private async readEpisode(
		serverId: string,
	): Promise<McpConnectionEpisodeRecord> {
		return (
			(await this.ctx.storage.get<McpConnectionEpisodeRecord>(
				mcpConnectionEpisodeStorageKey(serverId),
			)) ?? createInitialMcpConnectionEpisode()
		)
	}

	private async writeEpisode(
		serverId: string,
		episode: McpConnectionEpisodeRecord,
		event?: McpServerConnectionEvent,
	) {
		const entries: Record<string, unknown> = {
			[mcpConnectionEpisodeStorageKey(serverId)]: episode,
		}
		if (event) {
			const existing =
				(await this.ctx.storage.get<Array<McpServerConnectionEvent>>(
					mcpConnectionEventsPendingStorageKey,
				)) ?? []
			entries[mcpConnectionEventsPendingStorageKey] = [...existing, event]
		}
		await this.ctx.storage.put(entries)
	}

	private async lightweightReconnectServer(serverId: string) {
		const before = await this.readTokenPresence(serverId)
		this.clearSessionBeforeConnect(serverId)
		const connected = await this.connectToServerSerialized(serverId)
		if (connected.state === 'connected') {
			await this.manager.discoverIfConnected(serverId, {
				timeoutMs: mcpLightweightReconnectDiscoverTimeoutMs,
			})
		}
		return await this.finishConnectResult(serverId, before)
	}

	private async recoverUnavailableServer(serverId: string) {
		for (
			let attempt = 0;
			attempt < mcpLightweightReconnectAttempts;
			attempt++
		) {
			if (attempt > 0) {
				const backoffMs = mcpLightweightReconnectBackoffMs[attempt - 1] ?? 0
				if (backoffMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, backoffMs))
				}
			}
			try {
				const result = await this.lightweightReconnectServer(serverId)
				if (result.state === 'ready' || result.state === 'authenticating') {
					return
				}
			} catch {
				// The next attempt (or the observe pass) records the still-down state.
			}
		}
	}

	private async observeServer(input: { serverId: string; serverName: string }) {
		const previous = await this.readEpisode(input.serverId)
		const currentState = this.connectionStateFor(input.serverId)
		const presence =
			this.tokenPresence.get(input.serverId) ??
			(await this.readTokenPresence(input.serverId))
		const lastError = this.lastDiscoverErrors.get(input.serverId) ?? null
		// After a successful grant, settle clears last_error and saves
		// tokens while the connection may still be authenticating.
		// Inferring from refresh-token presence would emit a false
		// disconnect for first-add / still-settling Authorize.
		const inferPreviouslyReady =
			currentState === 'authenticating' &&
			shouldQueueMcpTokenRecoveryDisconnected({
				wasReady: previous.wasReady,
				presence,
				hasTokenRecoveryLastError: isMcpOAuthTokenRecoveryLastError(lastError),
			})
		const first = observeMcpConnectionState({
			previous: inferPreviouslyReady
				? episodeAsPreviouslyReady(previous)
				: previous,
			currentState,
			retryCompleted: false,
			createEpisodeId: () => crypto.randomUUID(),
		})
		let decision = first
		if (first.shouldRetry) {
			await this.writeEpisode(input.serverId, first.next)
			await this.recoverUnavailableServer(input.serverId)
			decision = observeMcpConnectionState({
				previous: first.next,
				currentState: this.connectionStateFor(input.serverId),
				retryCompleted: true,
				createEpisodeId: () => crypto.randomUUID(),
			})
		}
		await this.writeEpisode(
			input.serverId,
			decision.next,
			decision.event
				? {
						topic: decision.event.topic,
						eventId: crypto.randomUUID(),
						episodeId: decision.event.episodeId,
						serverId: input.serverId,
						serverName: input.serverName,
						state: this.connectionStateFor(input.serverId),
						previousState: decision.event.previousState,
						observedAt: new Date().toISOString(),
					}
				: undefined,
		)
	}

	private async connectToServerSerialized(serverId: string) {
		const previous = this.connectLocks.get(serverId) ?? Promise.resolve()
		let release = () => {}
		const current = new Promise<void>((resolve) => {
			release = resolve
		})
		this.connectLocks.set(serverId, current)
		await previous.catch(() => {})
		try {
			const result = await this.manager.connectToServer(serverId)
			if (result.state === 'failed' && result.error) {
				this.connectErrors.set(
					serverId,
					describeMcpOAuthClientRegistrationError(result.error),
				)
			} else {
				this.connectErrors.delete(serverId)
			}
			return result
		} finally {
			release()
			if (this.connectLocks.get(serverId) === current) {
				this.connectLocks.delete(serverId)
			}
		}
	}

	private async connectUsingStoredOAuthTokens(serverId: string) {
		const before = await this.readTokenPresence(serverId)
		this.clearSessionBeforeConnect(serverId)
		const connected = await this.connectToServerSerialized(serverId)
		if (connected.state === 'connected') {
			return (await this.runDiscoverIfConnected(serverId)).result
		}
		return await this.finishConnectResult(serverId, before)
	}

	private async finishConnectResult(
		serverId: string,
		beforeTokens?: McpOAuthTokenPresence,
	) {
		await this.stampTokenRecoveryIfAuthenticating(serverId, beforeTokens)
		return this.finalizeConnectResult(serverId)
	}

	private async readTokenPresence(
		serverId: string,
	): Promise<McpOAuthTokenPresence> {
		const authProvider =
			this.manager.mcpConnections[serverId]?.options.transport.authProvider
		const tokensFn = (
			authProvider as { tokens?: () => Promise<unknown> } | undefined
		)?.tokens
		let presence: McpOAuthTokenPresence = {
			hasAccessToken: false,
			hasRefreshToken: false,
		}
		if (typeof tokensFn === 'function') {
			try {
				presence = readMcpOAuthTokenPresence(await tokensFn.call(authProvider))
			} catch {
				presence = { hasAccessToken: false, hasRefreshToken: false }
			}
		}
		this.tokenPresence.set(serverId, presence)
		return presence
	}

	private async hydrateTokenRecoveryErrors() {
		const entries = await this.ctx.storage.list({
			prefix: mcpOAuthTokenRecoveryStoragePrefix,
		})
		for (const [key, value] of entries) {
			const serverId = key.slice(mcpOAuthTokenRecoveryStoragePrefix.length)
			const lastError =
				typeof value === 'string'
					? parseStoredMcpServerLastError(value)
					: parseStoredMcpServerLastError(JSON.stringify(value))
			if (!serverId || !lastError) continue
			this.lastDiscoverErrors.set(serverId, lastError)
			const connection = this.manager.mcpConnections[serverId]
			if (connection && !connection.connectionError) {
				connection.connectionError = lastError.message
			}
		}
	}

	private async persistTokenRecoveryLastError(
		serverId: string,
		lastError: McpServerLastError | null,
	) {
		const key = mcpOAuthTokenRecoveryStorageKey(serverId)
		if (!lastError) {
			await this.ctx.storage.delete(key)
			return
		}
		await this.ctx.storage.put(key, lastError)
	}

	private async clearTokenRecoveryLastError(serverId: string) {
		const existing = this.lastDiscoverErrors.get(serverId) ?? null
		const connection = this.manager.mcpConnections[serverId]
		const liveMessage = connection?.connectionError ?? null
		const liveLooksLikeGrantIssue =
			liveMessage != null &&
			isMcpOAuthGrantIssueLastError({
				message: liveMessage,
				phase: 'token exchange',
				httpStatus: null,
				httpBodySnippet: null,
				mcpEndpoint: null,
				resource: null,
				authServer: null,
				attemptId: 'unknown',
				at: new Date().toISOString(),
			})
		if (
			connection &&
			(liveLooksLikeGrantIssue ||
				(existing &&
					isMcpOAuthGrantIssueLastError(existing) &&
					liveMessage === existing.message))
		) {
			connection.connectionError = null
		}
		this.lastDiscoverErrors.delete(serverId)
		await this.persistTokenRecoveryLastError(serverId, null)
	}

	private async ensureTokenRecoveryDisconnectedEpisode(serverId: string) {
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		if (!row) return
		const previous = await this.readEpisode(serverId)
		const decision = observeMcpConnectionState({
			previous: episodeAsPreviouslyReady(previous),
			currentState: this.connectionStateFor(serverId),
			retryCompleted: true,
			createEpisodeId: () => crypto.randomUUID(),
		})
		await this.writeEpisode(
			serverId,
			decision.next,
			decision.event
				? {
						topic: decision.event.topic,
						eventId: crypto.randomUUID(),
						episodeId: decision.event.episodeId,
						serverId,
						serverName: row.name,
						state: this.connectionStateFor(serverId),
						previousState: decision.event.previousState,
						observedAt: new Date().toISOString(),
					}
				: undefined,
		)
	}

	private async stampTokenRecoveryIfAuthenticating(
		serverId: string,
		beforeTokens?: McpOAuthTokenPresence,
	) {
		const result = this.buildConnectResult(serverId)
		if (result.state !== 'authenticating') {
			if (result.state === 'ready') {
				await this.stampMissingRefreshGrantIfReady(serverId)
			}
			await this.readTokenPresence(serverId)
			return
		}
		const after = await this.readTokenPresence(serverId)
		const before = beforeTokens ?? after
		const episode = await this.readEpisode(serverId)
		const existing = this.lastDiscoverErrors.get(serverId) ?? null
		if (existing && isMcpOAuthTokenRecoveryLastError(existing)) {
			// Keep last_error while still authenticating, even if a refresh
			// token remains after saveTokens merge. Clear only on ready.
			const connection = this.manager.mcpConnections[serverId]
			if (connection) connection.connectionError = existing.message
			if (
				shouldQueueMcpTokenRecoveryDisconnected({
					wasReady: episode.wasReady,
					presence: before,
					hasTokenRecoveryLastError: true,
				})
			) {
				await this.ensureTokenRecoveryDisconnectedEpisode(serverId)
			}
			return
		}
		const shouldStamp =
			episode.wasReady ||
			shouldQueueMcpTokenRecoveryDisconnected({
				wasReady: false,
				presence: before,
				hasTokenRecoveryLastError: false,
			})
		if (!shouldStamp) return
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		const lastError = buildMcpOAuthTokenRecoveryLastError({
			authUrl: result.authUrl,
			mcpEndpoint: row?.server_url ?? null,
			hadRefreshToken: before.hasRefreshToken,
			stillHasRefreshToken: after.hasRefreshToken,
		})
		const connection = this.manager.mcpConnections[serverId]
		if (connection) connection.connectionError = lastError.message
		this.lastDiscoverErrors.set(serverId, lastError)
		await this.persistTokenRecoveryLastError(serverId, lastError)
		if (
			shouldQueueMcpTokenRecoveryDisconnected({
				wasReady: episode.wasReady,
				presence: before,
				hasTokenRecoveryLastError: true,
			})
		) {
			await this.ensureTokenRecoveryDisconnectedEpisode(serverId)
		}
		console.warn('mcp oauth token recovery parked authenticating', {
			attemptId: lastError.attemptId,
			serverId,
			hadRefreshToken: before.hasRefreshToken,
			stillHasRefreshToken: after.hasRefreshToken,
			mcpEndpoint: lastError.mcpEndpoint,
		})
	}

	private async stampMissingRefreshGrantIfReady(serverId: string) {
		const presence = await this.readTokenPresence(serverId)
		if (presence.hasRefreshToken) {
			await this.ctx.storage.delete(
				mcpOAuthRefreshGrantOmittedStorageKey(serverId),
			)
			await this.clearTokenRecoveryLastError(serverId)
			return
		}
		// Only warn when saveTokens recorded that this grant omitted an
		// advertised refresh token. An empty tokens() after a concurrent
		// refresh wipe (or invalidate) must not look like "AS never sent one".
		const omittedGrant = await this.ctx.storage.get(
			mcpOAuthRefreshGrantOmittedStorageKey(serverId),
		)
		if (!omittedGrant) {
			await this.clearTokenRecoveryLastError(serverId)
			return
		}
		if (!(await this.discoveryAdvertisesRefresh(serverId))) {
			await this.ctx.storage.delete(
				mcpOAuthRefreshGrantOmittedStorageKey(serverId),
			)
			await this.clearTokenRecoveryLastError(serverId)
			return
		}
		const existing = this.lastDiscoverErrors.get(serverId) ?? null
		if (isMcpOAuthMissingRefreshGrantLastError(existing)) return
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		const lastError = buildMcpOAuthMissingRefreshGrantLastError({
			authUrl: row?.auth_url ?? null,
			mcpEndpoint: row?.server_url ?? null,
		})
		const connection = this.manager.mcpConnections[serverId]
		if (connection) connection.connectionError = lastError.message
		this.lastDiscoverErrors.set(serverId, lastError)
		await this.persistTokenRecoveryLastError(serverId, lastError)
		console.warn('mcp oauth grant omitted advertised refresh token', {
			attemptId: lastError.attemptId,
			serverId,
			mcpEndpoint: lastError.mcpEndpoint,
		})
	}

	private async discoveryAdvertisesRefresh(serverId: string) {
		const authProvider =
			this.manager.mcpConnections[serverId]?.options.transport.authProvider
		const discoveryFn = (
			authProvider as { discoveryState?: () => Promise<unknown> } | undefined
		)?.discoveryState
		if (typeof discoveryFn === 'function') {
			try {
				if (
					mcpOAuthDiscoveryAdvertisesRefresh(
						await discoveryFn.call(authProvider),
					)
				) {
					return true
				}
			} catch {
				// Fall through to stored discovery blobs.
			}
		}
		const prefix = `/${mcpClientName}/${serverId}/`
		const entries = await this.ctx.storage.list({ prefix })
		for (const value of entries.values()) {
			if (mcpOAuthDiscoveryAdvertisesRefresh(value)) return true
		}
		return false
	}

	private readRegisteredServerIds() {
		return this.ctx.storage.sql
			.exec<{ id: string }>(`SELECT id FROM cf_agents_mcp_servers`)
			.toArray()
			.map((row) => row.id)
	}

	private async readStagedServer(serverId: string) {
		return await this.ctx.storage.get<McpHubStagedServer>(
			mcpTransferStagingStorageKey(serverId),
		)
	}

	/** Org resource transfer planning: registered and staged server ids. */
	async listServerIdsForTransfer(): Promise<Array<string>> {
		const staged = await this.ctx.storage.list({
			prefix: mcpTransferStagingStoragePrefix,
		})
		return [
			...this.readRegisteredServerIds(),
			...[...staged.keys()].map((key) =>
				key.slice(mcpTransferStagingStoragePrefix.length),
			),
		]
	}

	/** Org resource transfer: this server's SDK row and every per-server key. */
	async exportServerForTransfer(input: {
		serverId: string
	}): Promise<McpHubServerTransfer | null> {
		const [row] = this.ctx.storage.sql
			.exec<McpHubServerTransfer['row']>(
				`SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
				 FROM cf_agents_mcp_servers WHERE id = ?`,
				input.serverId,
			)
			.toArray()
		if (!row) return null
		const entries = await this.ctx.storage.list({
			prefix: mcpServerOAuthStoragePrefix(input.serverId),
		})
		const sidecars = await this.ctx.storage.get(
			mcpServerSidecarStorageKeys(input.serverId),
		)
		return { row: { ...row }, entries: [...entries, ...sidecars] }
	}

	/**
	 * Org resource transfer: stage a server exported from another owner's hub,
	 * with its tokens, in one storage write. It is not registered, so neither
	 * this call nor a later restore dials it; that waits for
	 * {@link connectTransferredServer} after the transfer commits. Refuses a
	 * server id this hub already has.
	 */
	async importServerForTransfer(
		input: McpHubServerTransfer,
	): Promise<McpHubServerImportResult> {
		const serverId = input.row.id
		if (
			this.readRegisteredServerIds().includes(serverId) ||
			(await this.readStagedServer(serverId))
		) {
			return { ok: false, reason: 'already_registered' }
		}
		if (hasForeignTransferStorageKey(input)) {
			return { ok: false, reason: 'foreign_storage_key' }
		}
		const staged: McpHubStagedServer = {
			row: { ...input.row },
			keys: input.entries.map(([key]) => key),
		}
		await this.ctx.storage.put({
			...Object.fromEntries(input.entries),
			[mcpTransferStagingStorageKey(serverId)]: staged,
		})
		return { ok: true }
	}

	/** Org resource transfer rollback: drop a staged server and its keys. */
	async discardTransferredServer(input: { serverId: string }): Promise<void> {
		const staged = await this.readStagedServer(input.serverId)
		if (!staged) return
		await this.ctx.storage.delete([
			mcpTransferStagingStorageKey(input.serverId),
			...staged.keys,
		])
	}

	/** Org resource transfer, after commit: register and dial a staged server. */
	async connectTransferredServer(input: {
		serverId: string
	}): Promise<McpHubConnectResult> {
		await this.ensureRestored()
		const serverId = input.serverId
		const staged = await this.readStagedServer(serverId)
		if (!staged) {
			throw new Error(`MCP server "${serverId}" is not staged.`)
		}
		const sealed = await this.readSealedPreRegisteredOAuthClient(serverId)
		if (sealed) this.preRegisteredClientIds.set(serverId, sealed.clientId)
		await this.hydrateTokenRecoveryErrors()
		this.operationallyRestored = true
		const persisted = parsePersistedMcpServerOptions(staged.row.server_options)
		const options = reconnectMcpServerOptions(
			persisted ? sanitizePersistedMcpServerOptions(persisted) : undefined,
		)
		const persistedType = options.transport.type
		const transportType: 'sse' | 'streamable-http' | 'auto' =
			persistedType === 'sse' || persistedType === 'streamable-http'
				? persistedType
				: 'auto'
		const authProvider = this.createAuthProvider(staged.row.callback_url)
		authProvider.serverId = serverId
		if (staged.row.client_id) authProvider.clientId = staged.row.client_id
		await this.manager.registerServer(serverId, {
			url: staged.row.server_url,
			name: staged.row.name,
			callbackUrl: staged.row.callback_url,
			...(staged.row.client_id ? { clientId: staged.row.client_id } : {}),
			...(staged.row.auth_url ? { authUrl: staged.row.auth_url } : {}),
			client: options.client,
			transport: withStaticTransportHeaders(
				withMcpOAuthTransportFetch({
					...options.transport,
					type: transportType,
					authProvider,
				}),
			),
		})
		await this.ctx.storage.delete(mcpTransferStagingStorageKey(serverId))
		const connection = this.manager.mcpConnections[serverId]
		if (staged.row.auth_url && connection) {
			// Same as the SDK restore path: a pending authorization waits for its
			// callback instead of dialing the server.
			connection.connectionState = 'authenticating'
		} else {
			await this.connectUsingStoredOAuthTokens(serverId)
		}
		await this.observeServer({ serverId, serverName: staged.row.name })
		return this.finalizeConnectResult(serverId)
	}

	/**
	 * Org resource transfer, after commit: drop a moved server and all its
	 * keys from the source hub. An isolate that has not restored yet deletes
	 * the row directly, because restoring would dial the server first and
	 * could rotate the tokens the target hub now holds.
	 */
	async removeServerForTransfer(input: { serverId: string }): Promise<void> {
		if (this.restored) {
			await this.removeServer(input)
		} else {
			this.ctx.storage.sql.exec(
				`DELETE FROM cf_agents_mcp_servers WHERE id = ?`,
				input.serverId,
			)
		}
		const oauthEntries = await this.ctx.storage.list({
			prefix: mcpServerOAuthStoragePrefix(input.serverId),
		})
		await this.ctx.storage.delete([
			...oauthEntries.keys(),
			...mcpServerSidecarStorageKeys(input.serverId),
		])
	}

	/** Close all connections and wipe stored servers, tokens, and OAuth state. */
	async purgeForAccountDeletion(): Promise<void> {
		try {
			await this.manager.closeAllConnections()
		} catch {
			// Connections that fail to close cleanly must not block deletion.
		}
		this.restored = null
		this.operationallyRestored = false
		this.preRegisteredClients.clear()
		this.preRegisteredClientIds.clear()
		await this.ctx.storage.deleteAll()
	}
}

export const McpClientHub = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	McpClientHubBase,
)

export type McpClientHub = InstanceType<typeof McpClientHub>
