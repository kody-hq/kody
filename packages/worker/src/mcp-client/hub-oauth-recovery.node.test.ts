import { mcpReadSnapshotStorageKey } from './read-snapshot.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import {
	mcpOAuthRefreshGrantOmittedStorageKey,
	mcpOAuthRefreshTokenStorageKey,
} from './oauth-token-recovery.ts'

type FakeServerRow = {
	id: string
	name: string
	server_url: string
	callback_url: string
	client_id: string | null
	auth_url: string | null
	server_options: string | null
}

type StoredTokens = { access_token?: string; refresh_token?: string } | null

type FakeConnection = {
	connectionState: string
	connectionError: string | null
	instructions: string | null
	tools: Array<never>
	options: {
		client: Record<string, unknown>
		transport: {
			type: string
			headers?: Record<string, string>
			sessionId?: string
			protocolVersion?: string
			authProvider: {
				serverId: string
				clientId?: string
				authUrl?: string
				redirectUrl: string
				storedTokens?: StoredTokens
				storedDiscovery?: unknown
				tokens?: () => Promise<unknown>
				discoveryState?: () => Promise<unknown>
			}
		}
	}
}

type ConnectBehavior =
	| 'oauth'
	| 'ready'
	| 'disconnected'
	| 'connected'
	| 'authenticating-no-url'

type FakeManager = {
	rows: Array<FakeServerRow>
	mcpConnections: Record<string, FakeConnection>
	connectCount: number
	registerCount: number
	discoverCount: number
	discoverSucceedsOn: 'never' | 'always' | 'legacy'
	connectBehavior: ConnectBehavior
	connectBehaviors: Array<ConnectBehavior>
	registerFailuresRemaining: number
	callbackMatches: boolean
	callbackResult: {
		serverId?: string
		authSuccess: boolean
		authError?: string
	}
}

const mockModule = vi.hoisted(() => ({
	manager: null as FakeManager | null,
}))

vi.mock('@sentry/cloudflare', () => ({
	instrumentDurableObjectWithSentry: (
		_factory: unknown,
		durableObjectClass: new (...args: Array<never>) => unknown,
	) => durableObjectClass,
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		DurableObject: class {
			protected readonly ctx: DurableObjectState
			protected readonly env: Env

			constructor(ctx: DurableObjectState, env: Env) {
				this.ctx = ctx
				this.env = env
			}
		},
	}
})

vi.mock('agents/mcp/do-oauth-client-provider', () => ({
	DurableObjectOAuthClientProvider: class {
		serverId = ''
		clientId: string | undefined
		authUrl: string | undefined
		readonly redirectUrl: string

		constructor(
			_storage: DurableObjectStorage,
			_clientName: string,
			redirectUrl: string,
		) {
			this.redirectUrl = redirectUrl
		}
	},
}))

vi.mock('agents/lifecycle', () => ({
	Lifecycle: class {
		static install() {
			return new this()
		}

		private capabilities: Array<{ onStart?: () => Promise<void> }> = []

		use(capability: { onStart?: () => Promise<void> }) {
			this.capabilities.push(capability)
			return this
		}

		async start() {
			for (const capability of this.capabilities) {
				await capability.onStart?.()
			}
		}
	},
}))

vi.mock('agents/mcp/client', () => ({
	MCPClientManager: class {
		rows: Array<FakeServerRow> = []
		mcpConnections: Record<string, FakeConnection> = {}
		connectCount = 0
		registerCount = 0
		discoverCount = 0
		discoverSucceedsOn: 'never' | 'always' | 'legacy' = 'never'
		connectBehavior: ConnectBehavior = 'oauth'
		connectBehaviors: Array<ConnectBehavior> = []
		registerFailuresRemaining = 0
		callbackMatches = true
		callbackResult = {
			serverId: 'server-1',
			authSuccess: false,
			authError: 'State not found or already used',
		}

		constructor() {
			mockModule.manager = this
		}

		async onStart() {}

		async waitForConnections() {}

		listServers() {
			return this.rows
		}

		async removeServer(serverId: string) {
			this.rows = this.rows.filter((row) => row.id !== serverId)
			delete this.mcpConnections[serverId]
		}

		async registerServer(
			serverId: string,
			options: {
				url: string
				name: string
				callbackUrl: string
				clientId?: string
				authUrl?: string
				client?: Record<string, unknown>
				transport: FakeConnection['options']['transport']
			},
		) {
			if (this.registerFailuresRemaining > 0) {
				this.registerFailuresRemaining -= 1
				throw new Error('Replacement registration failed.')
			}
			this.registerCount += 1
			this.rows.push({
				id: serverId,
				name: options.name,
				server_url: options.url,
				callback_url: options.callbackUrl,
				client_id: options.clientId ?? null,
				auth_url: options.authUrl ?? null,
				server_options: null,
			})
			this.mcpConnections[serverId] = {
				connectionState: 'disconnected',
				connectionError: null,
				instructions: null,
				tools: [],
				options: {
					client: options.client ?? {},
					transport: options.transport,
				},
			}
		}

		async establishConnection() {}

		async connectToServer(serverId: string) {
			this.connectCount += 1
			const connection = this.mcpConnections[serverId]
			if (!connection) throw new Error('Missing fake connection.')
			const provider = connection.options.transport.authProvider
			const connectBehavior =
				this.connectBehaviors.shift() ?? this.connectBehavior
			if (connectBehavior === 'ready') {
				connection.connectionState = 'ready'
				connection.connectionError = null
				return { state: 'connected' }
			}
			if (connectBehavior === 'connected') {
				connection.connectionState = 'connected'
				connection.connectionError = null
				return { state: 'connected' }
			}
			if (connectBehavior === 'disconnected') {
				connection.connectionState = 'disconnected'
				connection.connectionError = 'upstream closed'
				return { state: 'disconnected' }
			}
			if (connectBehavior === 'authenticating-no-url') {
				// Stuck authenticating with a grant but no authorize URL — remint
				// must keep leftover refresh tokens (read presence before remove).
				connection.connectionState = 'authenticating'
				connection.connectionError = null
				provider.authUrl = undefined
				const row = this.rows.find((item) => item.id === serverId)
				if (row) row.auth_url = null
				return { state: 'authenticating' }
			}
			if (provider.storedTokens) provider.storedTokens = null
			provider.clientId ??= `client-${this.connectCount}`
			provider.authUrl = `https://auth.example/authorize?state=fresh-${this.connectCount}.${serverId}&redirect_uri=${encodeURIComponent(provider.redirectUrl)}`
			connection.connectionState = 'authenticating'
			const row = this.rows.find((item) => item.id === serverId)
			if (!row) throw new Error('Missing fake server row.')
			row.client_id = provider.clientId
			row.auth_url = provider.authUrl
			return {
				state: 'authenticating',
				authUrl: provider.authUrl,
				clientId: provider.clientId,
			}
		}

		async discoverIfConnected(serverId: string) {
			this.discoverCount += 1
			const connection = this.mcpConnections[serverId]
			if (!connection) return
			const negotiation = Reflect.get(
				connection.options.client,
				'versionNegotiation',
			)
			const isLegacy =
				negotiation != null &&
				typeof negotiation === 'object' &&
				Reflect.get(negotiation, 'mode') === 'legacy'
			if (
				this.discoverSucceedsOn === 'always' ||
				(this.discoverSucceedsOn === 'legacy' && isLegacy)
			) {
				connection.connectionState = 'ready'
				connection.connectionError = null
			}
		}

		isCallbackRequest() {
			return this.callbackMatches
		}

		async handleCallbackRequest() {
			return this.callbackResult
		}
	},
}))

const { McpClientHub } = await import('./hub.ts')

type Hub = InstanceType<typeof McpClientHub>

const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
const recoveryKey = 'mcp-oauth-token-recovery/server-1'
const episodeKey = 'mcp-connection-episode/server-1'
const pendingEventsKey = 'mcp-connection-events-pending'
const legacyKey = 'mcp-legacy-handshake/server-1'
const tokenKey = '/Kody/server-1/client-1/token'
const noRefreshTokenMessage =
	"This MCP server's stored access token is no longer usable and Kody has no refresh token to renew it"
const autoClient = { versionNegotiation: { mode: 'auto' } }
const legacyClient = { versionNegotiation: { mode: 'legacy' } }

function createHub() {
	const values = new Map<string, unknown>()
	const state = {
		storage: {
			sql: { exec: vi.fn(() => []) },
			put: vi.fn(
				async (
					keyOrEntries: string | Record<string, unknown>,
					value?: unknown,
				) => {
					if (typeof keyOrEntries === 'string') {
						values.set(keyOrEntries, value)
						return
					}
					for (const [key, entryValue] of Object.entries(keyOrEntries)) {
						values.set(key, entryValue)
					}
				},
			),
			get: vi.fn(async (key: string) => values.get(key)),
			list: vi.fn(async ({ prefix }: { prefix: string }) => {
				return new Map(
					[...values.entries()].filter(([key]) => key.startsWith(prefix)),
				)
			}),
			delete: vi.fn(async (keys: string | Array<string>) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					values.delete(key)
				}
			}),
		},
	} as unknown as DurableObjectState
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	return { state, values, hub, manager }
}

function seedServer(
	manager: FakeManager,
	input: { callbackUrl?: string; clientId?: string; authUrl?: string } = {},
) {
	const redirectUrl = input.callbackUrl ?? callbackUrl
	const clientId = input.clientId ?? 'client-1'
	const authUrl =
		input.authUrl ?? 'https://auth.example/authorize?state=ok.server-1'
	const provider = {
		serverId: 'server-1',
		clientId,
		authUrl,
		redirectUrl,
		storedTokens: null as StoredTokens,
		storedDiscovery: undefined as unknown,
		async tokens() {
			return this.storedTokens ?? undefined
		},
		async discoveryState() {
			return this.storedDiscovery
		},
	}
	manager.rows = [
		{
			id: 'server-1',
			name: 'mediarss',
			server_url: 'https://mediarss.example/mcp',
			callback_url: redirectUrl,
			client_id: clientId,
			auth_url: authUrl,
			server_options: null,
		},
	]
	const connection: FakeConnection = {
		connectionState: 'authenticating',
		connectionError: null,
		instructions: null,
		tools: [],
		options: {
			client: {},
			transport: {
				type: 'auto',
				headers: { 'X-Test': 'preserved' },
				sessionId: 'stale-2025-session',
				protocolVersion: '2025-11-25',
				authProvider: provider,
			},
		},
	}
	manager.mcpConnections = { 'server-1': connection }
	return connection
}

async function seedReadyHomeServer(hub: Hub, manager: FakeManager) {
	const connection = seedServer(manager)
	connection.connectionState = 'ready'
	manager.rows[0]!.name = 'home'
	await hub.getSnapshot()
	return connection
}

function setTokens(connection: FakeConnection, tokens: StoredTokens) {
	connection.options.transport.authProvider.storedTokens = tokens
}

function oauthCallback(hub: Hub, state: string) {
	return hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=${state}.server-1`,
		callbackUrl,
	})
}

function reconnect(hub: Hub) {
	return hub.reconnectServer({ serverId: 'server-1', callbackUrl })
}

function addServer(hub: Hub, input: { name?: string; url?: string } = {}) {
	return hub.addServer({
		serverId: 'server-1',
		name: input.name ?? 'analytics',
		url: input.url ?? 'https://analytics.example/mcp',
		callbackUrl,
	})
}

function acceptCallback(manager: FakeManager) {
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
}

function parkWithStaleAccessToken(
	manager: FakeManager,
	connection: FakeConnection,
	tokens: StoredTokens,
) {
	connection.connectionState = 'authenticating'
	connection.connectionError = null
	setTokens(connection, tokens)
	manager.rows[0]!.auth_url =
		'https://auth.example/authorize?state=fresh.server-1'
}

function setRecoveryRecord(values: Map<string, unknown>, message: string) {
	values.set(recoveryKey, {
		message,
		phase: 'token exchange',
		attemptId: 'stale-rt',
		at: '2026-09-14T00:00:00.000Z',
	})
}

test('reconnect repairs stale callbacks and always replaces pending OAuth state', async () => {
	const { values, hub, manager } = createHub()
	const oldCallback = 'https://heykody.app/account/mcp-servers/oauth/callback'
	seedServer(manager, {
		callbackUrl: oldCallback,
		clientId: 'stale-client',
		authUrl: 'https://auth.example/authorize?state=stale.server-1',
	})
	values.set('/Kody/server-1/stale-client/client_info/', {
		client_id: 'stale-client',
	})
	values.set('/Kody/server-1/state/stale', { serverId: 'server-1' })
	values.set(mcpOAuthRefreshTokenStorageKey('server-1'), {
		refresh_token: 'old-rt',
	})

	const repaired = await reconnect(hub)
	expect(repaired.state).toBe('authenticating')
	expect(repaired.authUrl).toContain('state=fresh-1.server-1')
	expect(repaired.authUrl).toContain(encodeURIComponent(callbackUrl))
	expect(manager.rows[0]?.callback_url).toBe(callbackUrl)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	const connection = manager.mcpConnections['server-1']
	expect(connection?.options.transport.headers).toEqual({
		'X-Test': 'preserved',
	})
	expect(connection?.options.transport.sessionId).toBeUndefined()
	expect(connection?.options.transport.protocolVersion).toBeUndefined()
	expect(connection?.options.client).toMatchObject(autoClient)
	expect([...values.keys()].filter((key) => key.startsWith('/Kody/'))).toEqual(
		[],
	)
	expect(values.has(mcpOAuthRefreshTokenStorageKey('server-1'))).toBe(false)

	values.set('/Kody/server-1/client-1/client_info/', { client_id: 'client-1' })
	values.set('/Kody/server-1/state/fresh-1', { serverId: 'server-1' })
	const restarted = await reconnect(hub)
	expect(restarted.authUrl).toContain('state=fresh-2.server-1')
	expect(restarted.authUrl).not.toBe(repaired.authUrl)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	expect(values.has('/Kody/server-1/client-1/client_info/')).toBe(true)
	expect(values.has('/Kody/server-1/state/fresh-1')).toBe(false)
})

test('failed replacement registration restores the saved server and OAuth state', async () => {
	const { values, hub, manager } = createHub()
	const oldCallback = 'https://heykody.app/account/mcp-servers/oauth/callback'
	const oldAuthUrl = 'https://auth.example/authorize?state=stale.server-1'
	seedServer(manager, {
		callbackUrl: oldCallback,
		clientId: 'stale-client',
		authUrl: oldAuthUrl,
	})
	const clientInfoKey = '/Kody/server-1/stale-client/client_info/'
	const stateKey = '/Kody/server-1/state/stale'
	const sidecarKey = mcpOAuthRefreshTokenStorageKey('server-1')
	values.set(clientInfoKey, { client_id: 'stale-client' })
	values.set(stateKey, { serverId: 'server-1' })
	values.set(sidecarKey, { refresh_token: 'old-rt' })
	manager.registerFailuresRemaining = 1

	await expect(reconnect(hub)).rejects.toThrow(
		'Replacement registration failed.',
	)
	expect(manager.rows).toEqual([
		expect.objectContaining({
			id: 'server-1',
			callback_url: oldCallback,
			client_id: 'stale-client',
			auth_url: oldAuthUrl,
		}),
	])
	expect(manager.mcpConnections['server-1']?.options.transport.headers).toEqual(
		{ 'X-Test': 'preserved' },
	)
	expect(values.get(clientInfoKey)).toEqual({ client_id: 'stale-client' })
	expect(values.get(stateKey)).toEqual({ serverId: 'server-1' })
	expect(values.get(sidecarKey)).toEqual({ refresh_token: 'old-rt' })
})

test('replayed unusable callbacks leave past-OAuth server credentials intact', async () => {
	const { values, hub, manager } = createHub()
	const connection = seedServer(manager, {
		authUrl: 'https://auth.example/authorize?state=used.server-1',
	})
	manager.callbackMatches = false
	manager.rows[0]!.auth_url = null
	values.set(tokenKey, { access_token: 'still-valid' })
	connection.connectionState = 'ready'

	expect(await oauthCallback(hub, 'used')).toEqual({
		serverId: 'server-1',
		authSuccess: true,
		authError: null,
		serverName: 'mediarss',
		authorizationNeeded: false,
		lastError: null,
	})
	expect(manager.connectCount).toBe(0)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	expect(values.get(tokenKey)).toEqual({ access_token: 'still-valid' })
})

test('used and missing callback states recover without exposing an internal state error', async () => {
	const { hub, manager } = createHub()
	seedServer(manager, {
		authUrl: 'https://auth.example/authorize?state=used.server-1',
	})

	const usedState = await oauthCallback(hub, 'used')
	expect(usedState.authorizationNeeded).toBe(true)
	expect(usedState.authSuccess).toBe(false)
	expect(usedState.serverId).toBe('server-1')
	expect(usedState.authError).toBeTruthy()
	expect(usedState.authError).not.toContain('state')
	expect(manager.rows[0]?.auth_url).toContain('state=fresh-1.server-1')

	manager.callbackMatches = false
	const missingState = await hub.handleOAuthCallback({
		url: `${callbackUrl}?error=access_denied`,
		callbackUrl,
	})
	expect(missingState.authorizationNeeded).toBe(true)
	expect(missingState.serverId).toBe('server-1')
	expect(missingState.authError).not.toContain('state')
	expect(manager.rows[0]?.auth_url).toContain('state=fresh-2.server-1')
})

test('replayed unusable callback settles with stored tokens instead of reminting', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	connection.connectionState = 'authenticating'
	connection.connectionError = noRefreshTokenMessage
	manager.rows[0]!.auth_url = null
	setTokens(connection, {
		access_token: 'fresh-at',
		refresh_token: 'fresh-rt',
	})
	setRecoveryRecord(values, noRefreshTokenMessage)
	manager.callbackMatches = false
	manager.connectBehavior = 'ready'
	manager.registerCount = 0

	expect(await oauthCallback(hub, 'used')).toMatchObject({
		serverId: 'server-1',
		authSuccess: true,
		authorizationNeeded: false,
		lastError: null,
	})
	expect(manager.registerCount).toBe(0)
	expect(connection.options.transport.authProvider.storedTokens).toEqual({
		access_token: 'fresh-at',
		refresh_token: 'fresh-rt',
	})
	expect(values.has(recoveryKey)).toBe(false)
	expect(connection.connectionState).toBe('ready')
})

test('successful OAuth callback drops a stale no-refresh-token lastError', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	setRecoveryRecord(values, noRefreshTokenMessage)
	connection.connectionState = 'connected'
	connection.connectionError = null
	setTokens(connection, { access_token: 'new-at', refresh_token: 'new-rt' })
	acceptCallback(manager)
	manager.discoverSucceedsOn = 'always'

	const outcome = await oauthCallback(hub, 'ok')
	expect(outcome.authSuccess).toBe(true)
	expect(outcome.lastError).toBeNull()
	expect(values.has(recoveryKey)).toBe(false)
	expect(connection.connectionState).toBe('ready')
})

test('first-time OAuth grant that stays authenticating does not emit disconnected', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = seedServer(manager)
	setTokens(connection, { access_token: 'new-at', refresh_token: 'new-rt' })
	acceptCallback(manager)

	await oauthCallback(hub, 'ok')
	expect(connection.connectionState).toBe('authenticating')
	expect(await hub.peekConnectionEvents()).toEqual([])
	expect(values.has(pendingEventsKey)).toBe(false)
	expect(values.get(episodeKey)).toMatchObject({
		wasReady: false,
		disconnectedEmitted: false,
	})
	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('authenticating')
	expect(peeked.servers[0]?.lastError ?? null).toBeNull()
	expect(await hub.peekConnectionEvents()).toEqual([])
})

test('peekServers returns cards without observing or reconnecting', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	const episodeBefore = values.get(episodeKey)
	connection.connectionState = 'disconnected'
	manager.connectCount = 0
	manager.connectBehavior = 'ready'

	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('disconnected')
	expect(manager.connectCount).toBe(0)
	expect(values.get(episodeKey)).toEqual(episodeBefore)
	expect(values.has(pendingEventsKey)).toBe(false)
	expect(await hub.takeConnectionEvents()).toEqual([])
})

test('peekServers queues a disconnected episode when a ready server parks on token recovery, and ack removes only the dispatched ids', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	parkWithStaleAccessToken(manager, connection, {
		access_token: 'stale-at',
		refresh_token: 'still-rt',
	})

	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('authenticating')
	expect(peeked.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(values.get(episodeKey)).toMatchObject({
		wasReady: true,
		disconnectedEmitted: true,
	})
	const queued = await hub.peekConnectionEvents()
	expect(queued).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'home',
		}),
	])
	const second = await hub.peekServers()
	expect(second.servers[0]?.state).toBe('authenticating')
	expect(second.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(second.servers[0]?.hasRefreshToken).toBe(true)
	expect(values.get(recoveryKey)).toMatchObject({ phase: 'token exchange' })
	expect(await hub.peekConnectionEvents()).toHaveLength(1)

	const firstId = queued[0]?.eventId
	expect(firstId).toBeTruthy()
	const laterEvent = {
		...queued[0]!,
		eventId: 'later-event',
		topic: 'mcp.server.reconnected' as const,
		state: 'ready' as const,
	}
	values.set(pendingEventsKey, [...queued, laterEvent])
	await hub.ackConnectionEvents([firstId!])
	expect(await hub.peekConnectionEvents()).toEqual([laterEvent])
	expect(await hub.takeConnectionEvents()).toHaveLength(1)
})

test('token-recovery park with no refresh token still emits disconnected when wasReady was never stored', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = seedServer(manager, {
		authUrl: 'https://auth.example/authorize?state=fresh.server-1',
	})
	expect(values.has(episodeKey)).toBe(false)

	const firstAdd = await hub.peekServers()
	expect(firstAdd.servers[0]?.state).toBe('authenticating')
	expect(firstAdd.servers[0]?.lastError).toBeNull()
	expect(values.has(pendingEventsKey)).toBe(false)

	setTokens(connection, { access_token: 'stale-at' })
	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('authenticating')
	expect(peeked.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(peeked.servers[0]?.lastError?.message).toContain(
		'has no refresh token to renew',
	)
	expect(values.get(episodeKey)).toMatchObject({
		wasReady: true,
		disconnectedEmitted: true,
		lastObservedState: 'authenticating',
	})
	const downEvents = await hub.peekConnectionEvents()
	expect(downEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'mediarss',
			state: 'authenticating',
			previousState: 'ready',
		}),
	])
	const episodeId = downEvents[0]?.episodeId
	expect(episodeId).toBeTruthy()
	await hub.takeConnectionEvents()

	connection.connectionState = 'ready'
	connection.connectionError = null
	manager.connectBehavior = 'ready'
	const recovered = await hub.getSnapshot()
	expect(recovered.servers[0]?.state).toBe('ready')
	expect(recovered.servers[0]?.lastError ?? null).toBeNull()
	expect(recovered.servers[0]?.error ?? null).toBeNull()
	expect(recovered.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.reconnected',
			serverId: 'server-1',
			episodeId,
			state: 'ready',
		}),
	])
})

test('snapshot retries a previously ready server before emitting disconnect', async () => {
	const { state, values, hub, manager } = createHub()
	const connection = seedServer(manager)
	connection.connectionState = 'ready'
	manager.rows[0]!.name = 'home'

	const readySnapshot = await hub.getSnapshot()
	expect(readySnapshot.connectionEvents).toEqual([])
	expect(values.get(episodeKey)).toEqual({
		lastObservedState: 'ready',
		wasReady: true,
		episodeId: null,
		disconnectedEmitted: false,
	})

	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'ready'
	const recovered = await hub.getSnapshot()
	expect(manager.connectCount).toBe(1)
	expect(recovered.servers[0]?.state).toBe('ready')
	expect(recovered.connectionEvents).toEqual([])

	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'disconnected'
	const down = await hub.getSnapshot()
	expect(manager.connectCount).toBe(3)
	expect(down.servers[0]?.state).toBe('disconnected')
	expect(down.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'home',
			state: 'disconnected',
			previousState: 'ready',
		}),
	])
	const episode = values.get(episodeKey) as {
		episodeId: string
		disconnectedEmitted: boolean
	}
	expect(episode.disconnectedEmitted).toBe(true)
	expect(episode.episodeId).toBeTruthy()

	const stillDown = await hub.getSnapshot()
	expect(manager.connectCount).toBe(3)
	expect(stillDown.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			episodeId: (values.get(episodeKey) as { episodeId: string }).episodeId,
		}),
	])
	expect(await hub.takeConnectionEvents()).toHaveLength(1)
	expect(await hub.peekConnectionEvents()).toEqual([])

	connection.connectionState = 'ready'
	const back = await hub.getSnapshot()
	expect(back.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.reconnected',
			serverId: 'server-1',
			episodeId: episode.episodeId,
			state: 'ready',
		}),
	])

	const batchWrites = (
		state.storage.put as ReturnType<typeof vi.fn>
	).mock.calls.filter(
		(call): call is [Record<string, unknown>] =>
			typeof call[0] === 'object' &&
			call[0] !== null &&
			pendingEventsKey in call[0],
	)
	expect(batchWrites.length).toBeGreaterThan(0)
	for (const [entries] of batchWrites) {
		expect(
			Object.keys(entries).some((key) =>
				key.startsWith('mcp-connection-episode/'),
			),
		).toBe(true)
	}
})

test('remint for stuck authenticating without authUrl keeps leftover refresh tokens', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	const storedTokens = {
		access_token: 'stale-at',
		refresh_token: 'keep-rt',
	}
	setTokens(connection, { ...storedTokens })
	values.set(tokenKey, { ...storedTokens })
	values.set(mcpOAuthRefreshTokenStorageKey('server-1'), {
		refresh_token: 'keep-rt',
	})
	// Refresh-first parks without an auth URL; remint must still preserve the
	// grant (presence is read before removeServer).
	manager.connectBehaviors = ['authenticating-no-url', 'oauth']
	const reminted = await reconnect(hub)
	expect(reminted.state).toBe('authenticating')
	expect(reminted.authUrl).toBeTruthy()
	expect(manager.registerCount).toBe(1)
	expect(values.get(tokenKey)).toEqual(storedTokens)
	expect(values.get(mcpOAuthRefreshTokenStorageKey('server-1'))).toEqual({
		refresh_token: 'keep-rt',
	})
})

test('reconnect tries stored refresh before wiping tokens, and a parked authenticating lastError survives refreshServer', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	const storedTokens = {
		access_token: 'expired-at',
		refresh_token: 'rotating-rt',
	}
	setTokens(connection, { ...storedTokens })
	values.set(tokenKey, { ...storedTokens })
	manager.connectBehavior = 'ready'
	const refreshed = await reconnect(hub)
	expect(refreshed.state).toBe('ready')
	expect(refreshed.lastError ?? null).toBeNull()
	expect(refreshed.hasRefreshToken).toBe(true)
	expect(values.get(tokenKey)).toEqual(storedTokens)
	expect(manager.registerCount).toBe(0)

	manager.connectBehavior = 'oauth'
	setTokens(connection, { refresh_token: 'rotating-rt' })
	const parked = await reconnect(hub)
	expect(parked.state).toBe('authenticating')
	expect(parked.authUrl).toBeTruthy()
	expect(parked.error).toContain('could not be refreshed')
	expect(parked.lastError?.phase).toBe('token exchange')
	expect(parked.lastError?.message).not.toContain('Authorization completed')
	expect(parked.hasRefreshToken).toBe(false)
	expect(values.get(tokenKey)).toEqual(storedTokens)
	expect(values.get(recoveryKey)).toMatchObject({ phase: 'token exchange' })
	expect(manager.registerCount).toBe(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth token recovery parked authenticating',
		expect.objectContaining({
			serverId: 'server-1',
			hadRefreshToken: true,
			stillHasRefreshToken: false,
		}),
	)

	const stillParked = await hub.refreshServer({ serverId: 'server-1' })
	expect(stillParked.state).toBe('authenticating')
	expect(stillParked.lastError?.phase).toBe('token exchange')
	expect(stillParked.error).toContain('could not be refreshed')
	expect(stillParked.error).not.toContain('Authorization completed')
})

test('ready grant without a refresh token warns when the authorization server advertised refresh', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	const discovery = {
		grant_types_supported: ['authorization_code', 'refresh_token'],
		scopes_supported: ['mcp'],
	}
	setTokens(connection, { access_token: 'at-only' })
	connection.options.transport.authProvider.storedDiscovery = discovery
	values.set('/Kody/server-1/oauth_discovery', discovery)
	// Stamp only when saveTokens recorded that this grant omitted RT — not
	// whenever tokens() is empty while ready (e.g. after a refresh wipe).
	values.set(mcpOAuthRefreshGrantOmittedStorageKey('server-1'), {
		omitted: true,
		at: '2026-10-14T08:00:00.000Z',
	})

	const snapshot = await hub.getSnapshot()
	expect(snapshot.servers[0]?.state).toBe('ready')
	expect(snapshot.servers[0]?.hasRefreshToken).toBe(false)
	expect(snapshot.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(snapshot.connectionEvents).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth grant omitted advertised refresh token',
		expect.objectContaining({ serverId: 'server-1' }),
	)

	setTokens(connection, { access_token: 'at-new', refresh_token: 'rt-new' })
	const afterRefresh = await hub.getSnapshot()
	expect(afterRefresh.servers[0]?.hasRefreshToken).toBe(true)
	expect(afterRefresh.servers[0]?.lastError).toBeNull()
	expect(afterRefresh.servers[0]?.error).toBeNull()
	expect(connection.connectionError).toBeNull()
})

test('ready without a refresh token does not warn unless saveTokens marked the grant omitted', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	const discovery = {
		grant_types_supported: ['authorization_code', 'refresh_token'],
		scopes_supported: ['mcp'],
	}
	setTokens(connection, { access_token: 'at-only' })
	connection.options.transport.authProvider.storedDiscovery = discovery
	values.set('/Kody/server-1/oauth_discovery', discovery)

	const snapshot = await hub.getSnapshot()
	expect(snapshot.servers[0]?.state).toBe('ready')
	expect(snapshot.servers[0]?.hasRefreshToken).toBe(false)
	expect(snapshot.servers[0]?.lastError).toBeNull()
	expect(snapshot.connectionEvents).toEqual([])
})

test('snapshot after a prior ready connection parks authenticating with a durable token-recovery lastError', async () => {
	consoleWarn.mockImplementation(() => {})
	const { hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	parkWithStaleAccessToken(manager, connection, { access_token: 'stale-at' })

	const snapshot = await hub.getSnapshot()
	const card = snapshot.servers[0]
	expect(card?.state).toBe('authenticating')
	expect(card?.error).toContain('has no refresh token to renew')
	expect(card?.lastError?.phase).toBe('token exchange')
	expect(card?.hasRefreshToken).toBe(false)
	expect(card?.error).not.toContain('Authorization completed')
	expect(snapshot.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'home',
			state: 'authenticating',
			previousState: 'ready',
		}),
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth token recovery parked authenticating',
		expect.objectContaining({ serverId: 'server-1', hadRefreshToken: false }),
	)
})

test('authenticating park drops a leftover incomplete-discover lastError', async () => {
	const { hub, manager } = createHub()
	const connection = seedServer(manager)
	connection.connectionState = 'discovering'
	connection.connectionError = "tool discovery didn't finish"
	const hung = await hub.getSnapshot()
	expect(hung.servers[0]?.lastError?.phase).toBe('tools/list')
	expect(hung.servers[0]?.error).toContain("tool discovery didn't finish")

	connection.connectionState = 'authenticating'
	const parked = await hub.getSnapshot()
	expect(parked.servers[0]?.state).toBe('authenticating')
	expect(parked.servers[0]?.lastError ?? null).toBeNull()
	expect(parked.servers[0]?.error ?? null).toBeNull()
	expect(connection.connectionError).toBeNull()
})

test('refresh, reconnect, add, and OAuth callback return the recovered ready connection after a lightweight retry', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	setRecoveryRecord(values, 'Stored OAuth tokens could not be refreshed')
	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'ready'
	const refreshed = await hub.refreshServer({ serverId: 'server-1' })
	expect(refreshed.state).toBe('ready')
	expect(refreshed.lastError ?? null).toBeNull()
	expect(values.has(recoveryKey)).toBe(false)

	manager.connectBehaviors = ['disconnected', 'ready']
	expect((await reconnect(hub)).state).toBe('ready')

	manager.connectBehaviors = ['disconnected', 'ready']
	const added = await addServer(hub, {
		name: 'home',
		url: 'https://home.example.com/mcp',
	})
	expect(added.state).toBe('ready')

	const callbackHub = createHub()
	const callbackConnection = await seedReadyHomeServer(
		callbackHub.hub,
		callbackHub.manager,
	)
	callbackConnection.connectionState = 'disconnected'
	callbackHub.manager.connectBehavior = 'ready'
	acceptCallback(callbackHub.manager)
	const callback = await oauthCallback(callbackHub.hub, 'ok')
	expect(callback.authSuccess).toBe(true)
	expect(callback.authorizationNeeded).toBe(false)
	expect(callback.lastError).toBeNull()
})

test('handleOAuthCallback reports a durable tool-discovery lastError when IdP succeeds but settle stays connected', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	const connection = seedServer(manager)
	acceptCallback(manager)
	manager.connectBehavior = 'connected'
	connection.connectionState = 'connected'
	values.set('/Kody/server-1/oauth_discovery', {
		resource: 'https://mcp.posthog.com/',
		authorization_servers: ['https://auth.posthog.com/?client_secret=hidden'],
	})

	const result = await oauthCallback(hub, 'ok')
	expect(result.authSuccess).toBe(false)
	expect(result.authorizationNeeded).toBe(false)
	expect(result.lastError).toMatchObject({
		phase: 'tools/list',
		mcpEndpoint: 'https://mediarss.example/mcp',
		resource: 'https://mcp.posthog.com/',
		authServer: 'https://auth.posthog.com/',
	})
	expect(result.authError).toContain("tool discovery didn't finish")
	expect(result.authError).toContain('phase tools/list')
	expect(result.authError).toContain(`id ${result.lastError?.attemptId}`)
	expect(result.authError?.match(/authorization completed/gi)?.length).toBe(1)
	expect(result.authError?.match(/\bphase\s/g)?.length).toBe(1)
	expect(result.authError?.match(/\bid\s/g)?.length).toBe(1)
	expect(result.authError).not.toContain('client_secret')
	expect(JSON.stringify(result.lastError)).not.toContain('hidden')
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth callback settle incomplete',
		expect.objectContaining({
			attemptId: result.lastError?.attemptId,
			serverId: 'server-1',
			phase: 'tools/list',
			mcpEndpoint: 'https://mediarss.example/mcp',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/',
		}),
	)
	const logged = JSON.stringify(consoleWarn.mock.calls)
	expect(logged).not.toContain('hidden')
	expect(logged).not.toContain('client_secret')
})

test('replayed unusable callback after incomplete settle reports lastError instead of fake success', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	seedServer(manager, {
		authUrl: 'https://auth.example/authorize?state=used.server-1',
	})
	manager.callbackMatches = false
	manager.connectBehavior = 'connected'
	manager.rows[0]!.auth_url = null
	values.set(tokenKey, { access_token: 'still-valid' })
	values.set('/Kody/server-1/oauth_discovery', {
		resource: 'https://mcp.posthog.com/',
		authorization_servers: ['https://auth.posthog.com/'],
	})

	for (const inFlightState of ['connected', 'discovering', 'connecting']) {
		const connection = manager.mcpConnections['server-1']
		if (!connection) throw new Error('Fake connection was not seeded.')
		connection.connectionState = inFlightState
		connection.connectionError = null
		const outcome = await oauthCallback(hub, 'used')
		expect(outcome.authSuccess).toBe(false)
		expect(outcome.authorizationNeeded).toBe(false)
		expect(outcome.lastError).toMatchObject({
			mcpEndpoint: 'https://mediarss.example/mcp',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/',
		})
		expect(outcome.authError).toBeTruthy()
		if (inFlightState === 'connecting') {
			expect(outcome.lastError?.phase).toBe('mcp initialize')
			expect(outcome.authError).toContain('did not become ready')
		} else {
			expect(outcome.authError).toContain("tool discovery didn't finish")
		}
	}

	expect(manager.connectCount).toBe(1)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	expect(values.get(tokenKey)).toEqual({ access_token: 'still-valid' })
})

test('add, reconnect, and refresh treat a discover timeout as a durable lastError', async () => {
	consoleWarn.mockImplementation(() => {})
	const { hub, manager } = createHub()
	manager.connectBehavior = 'connected'

	const added = await addServer(hub, {
		name: 'mediarss',
		url: 'https://mediarss.example/mcp',
	})
	expect(added.state).toBe('connected')
	expect(added.lastError?.phase).toBe('tools/list')
	expect(added.lastError?.mcpEndpoint).toBe('https://mediarss.example/mcp')
	expect(added.lastError?.attemptId).toBeTruthy()
	expect(added.error).toContain("tool discovery didn't finish")
	expect(added.error).toContain('phase tools/list')
	expect(added.error).toContain(`id ${added.lastError?.attemptId}`)
	expect(added.error?.match(/\bid\s/g)?.length).toBe(1)
	expect(manager.mcpConnections['server-1']?.connectionError).toBe(added.error)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp discover retrying legacy handshake',
		expect.objectContaining({
			serverId: 'server-1',
			mcpEndpoint: 'https://mediarss.example/mcp',
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp discover timeout incomplete',
		expect.objectContaining({
			attemptId: added.lastError?.attemptId,
			serverId: 'server-1',
			phase: 'tools/list',
		}),
	)

	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'discovering'
	const refreshed = await hub.refreshServer({ serverId: 'server-1' })
	expect(refreshed.state).toBe('discovering')
	expect(refreshed.lastError?.phase).toBe('tools/list')
	expect(refreshed.lastError?.attemptId).toBeTruthy()
	expect(refreshed.lastError?.attemptId).not.toBe(added.lastError?.attemptId)
	expect(refreshed.error).toContain("tool discovery didn't finish")
	expect(refreshed.error).toContain('phase tools/list')
	expect(refreshed.error).toContain(`id ${refreshed.lastError?.attemptId}`)
	expect(refreshed.error?.match(/\bid\s/g)?.length).toBe(1)

	connection.connectionState = 'disconnected'
	connection.connectionError = null
	const reconnected = await reconnect(hub)
	expect(reconnected.state).toBe('connected')
	expect(reconnected.lastError?.phase).toBe('tools/list')
	expect(reconnected.lastError?.mcpEndpoint).toBe(
		'https://mediarss.example/mcp',
	)
})

test('legacy retry that fails to connect keeps the catalog lastError, and a later failed add drops it', async () => {
	consoleWarn.mockImplementation(() => {})
	const { hub, manager } = createHub()
	manager.connectBehaviors = ['connected', 'disconnected']
	manager.connectBehavior = 'disconnected'

	const added = await addServer(hub)
	expect(added.state).toBe('disconnected')
	expect(added.lastError?.phase).toBe('tools/list')
	expect(added.error).toContain("tool discovery didn't finish")
	expect(added.error).toContain('phase tools/list')
	expect(manager.mcpConnections['server-1']?.connectionError).toBe(added.error)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp discover retrying legacy handshake',
		expect.objectContaining({
			serverId: 'server-1',
			attemptId: added.lastError?.attemptId,
		}),
	)

	manager.connectBehaviors = []
	const failed = await addServer(hub)
	expect(failed.state).toBe('disconnected')
	expect(failed.lastError).toBeNull()
	expect(failed.error).toBe('upstream closed')
})

test('healthy auto catalog stays on auto; modern-connect catalog timeout falls back to legacy and can reach ready', async () => {
	consoleWarn.mockImplementation(() => {})
	const healthy = createHub()
	healthy.manager.connectBehavior = 'connected'
	healthy.manager.discoverSucceedsOn = 'always'
	const healthyAdded = await healthy.hub.addServer({
		serverId: 'server-healthy',
		name: 'feeds',
		url: 'https://feeds.example/mcp',
		callbackUrl,
	})
	expect(healthyAdded.state).toBe('ready')
	expect(healthyAdded.lastError ?? null).toBeNull()
	expect(healthy.manager.registerCount).toBe(1)
	expect(healthy.manager.discoverCount).toBe(1)
	expect(
		healthy.manager.mcpConnections['server-healthy']?.options.client,
	).toEqual(autoClient)
	expect(healthy.values.has('mcp-legacy-handshake/server-healthy')).toBe(false)

	const { values, hub, manager } = createHub()
	manager.connectBehavior = 'connected'
	manager.discoverSucceedsOn = 'legacy'
	const added = await addServer(hub, {
		url: 'https://user:secret@analytics.example/mcp?token=abc',
	})
	expect(added.state).toBe('ready')
	expect(added.lastError ?? null).toBeNull()
	expect(manager.registerCount).toBe(2)
	expect(manager.discoverCount).toBe(2)
	expect(manager.mcpConnections['server-1']?.options.client).toEqual(
		legacyClient,
	)
	expect(values.get(legacyKey)).toBe('catalog-timeout')
	const timeoutCall = consoleWarn.mock.calls.find(
		(call) => call[0] === 'mcp discover timeout incomplete',
	)
	const retryCall = consoleWarn.mock.calls.find(
		(call) => call[0] === 'mcp discover retrying legacy handshake',
	)
	const timeoutAttemptId = (
		timeoutCall?.[1] as { attemptId?: string } | undefined
	)?.attemptId
	expect(timeoutAttemptId).toBeTruthy()
	expect(retryCall?.[1]).toEqual(
		expect.objectContaining({
			serverId: 'server-1',
			attemptId: timeoutAttemptId,
			mcpEndpoint: 'https://analytics.example/mcp',
		}),
	)

	manager.discoverSucceedsOn = 'always'
	const reconnected = await reconnect(hub)
	expect(reconnected.state).toBe('ready')
	expect(manager.mcpConnections['server-1']?.options.client).toEqual(autoClient)
	expect(values.has(legacyKey)).toBe(false)

	manager.discoverSucceedsOn = 'legacy'
	const connection = seedServer(manager)
	connection.options.client = { ...autoClient }
	connection.connectionState = 'connected'
	acceptCallback(manager)
	manager.registerCount = 0
	manager.discoverCount = 0
	const oauth = await oauthCallback(hub, 'ok')
	expect(oauth.authSuccess).toBe(true)
	expect(oauth.lastError).toBeNull()
	expect(manager.registerCount).toBe(1)
	expect(manager.mcpConnections['server-1']?.options.client).toEqual(
		legacyClient,
	)
	expect(values.get(legacyKey)).toBe('catalog-timeout')
})

test('replacing a server forgets the catalog-timeout legacy mark and probes auto', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	manager.connectBehavior = 'connected'
	manager.discoverSucceedsOn = 'legacy'
	expect((await addServer(hub)).state).toBe('ready')
	expect(values.get(legacyKey)).toBe('catalog-timeout')

	manager.discoverSucceedsOn = 'always'
	manager.registerCount = 0
	manager.discoverCount = 0
	const replaced = await addServer(hub, { url: 'https://feeds.example/mcp' })
	expect(replaced.state).toBe('ready')
	expect(replaced.hasRefreshToken).toBe(false)
	expect(manager.registerCount).toBe(1)
	expect(manager.discoverCount).toBe(1)
	expect(manager.mcpConnections['server-1']?.options.client).toEqual(autoClient)
	expect(values.has(legacyKey)).toBe(false)
})

test('legacy fallback that parks on OAuth remembers the mark and keeps it after ready', async () => {
	consoleWarn.mockImplementation(() => {})
	const { values, hub, manager } = createHub()
	manager.connectBehaviors = ['connected', 'oauth']
	manager.connectBehavior = 'oauth'
	manager.discoverSucceedsOn = 'never'

	const added = await addServer(hub)
	expect(added.state).toBe('authenticating')
	expect(added.authUrl).toBeTruthy()
	expect(manager.mcpConnections['server-1']?.options.client).toEqual(
		legacyClient,
	)
	expect(values.get(legacyKey)).toBe('catalog-timeout')

	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'connected'
	manager.discoverSucceedsOn = 'always'
	acceptCallback(manager)
	const oauth = await oauthCallback(hub, 'ok')
	expect(oauth.authSuccess).toBe(true)
	expect(oauth.lastError).toBeNull()
	expect(manager.mcpConnections['server-1']?.options.client).toEqual(
		legacyClient,
	)
	expect(values.get(legacyKey)).toBe('catalog-timeout')
})

const preRegisteredClientKey = 'mcp-oauth-preregistered-client:server-1'

function sealedClient(clientId: string) {
	return { clientId, sealedClientSecret: `v2.sealed-for-${clientId}` }
}

function setOAuthClient(
	hub: Hub,
	client: ReturnType<typeof sealedClient> | null,
) {
	return hub.setPreRegisteredOAuthClient({
		serverId: 'server-1',
		callbackUrl,
		client,
	})
}

test('changing the OAuth client on a ready server parks for approval without a false token-recovery error', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	setTokens(connection, { access_token: 'old-at', refresh_token: 'old-rt' })
	values.set(tokenKey, { access_token: 'old-at', refresh_token: 'old-rt' })
	values.set(mcpOAuthRefreshTokenStorageKey('server-1'), {
		refresh_token: 'old-rt',
	})

	const change = await setOAuthClient(hub, sealedClient('gh-client'))
	expect(change).toMatchObject({
		changed: true,
		previousClientId: null,
		connection: { state: 'authenticating', error: null, lastError: null },
	})
	expect(values.get(preRegisteredClientKey)).toEqual(sealedClient('gh-client'))
	expect(values.has(tokenKey)).toBe(false)
	expect(values.has(mcpOAuthRefreshTokenStorageKey('server-1'))).toBe(false)
	expect(values.has(recoveryKey)).toBe(false)

	const snapshot = await hub.getSnapshot()
	expect(snapshot.servers[0]).toMatchObject({
		state: 'authenticating',
		error: null,
		lastError: null,
		oauthClientId: 'gh-client',
	})
	expect(values.has(recoveryKey)).toBe(false)
	expect(snapshot.connectionEvents).toEqual([])
})

test('a failed restart after a client change keeps the new client and reports it instead of half-restoring the old grant', async () => {
	const { values, hub, manager } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	setTokens(connection, { access_token: 'old-at', refresh_token: 'old-rt' })
	values.set(tokenKey, { access_token: 'old-at', refresh_token: 'old-rt' })
	manager.registerFailuresRemaining = 1

	const change = await setOAuthClient(hub, sealedClient('gh-client'))
	expect(change.changed).toBe(true)
	expect(change.connection.lastError?.message).toContain(
		'The OAuth client was saved, but Kody could not start authorization with it',
	)
	expect(values.get(preRegisteredClientKey)).toEqual(sealedClient('gh-client'))
	expect(values.has(tokenKey)).toBe(false)
	expect(manager.rows).toEqual([
		expect.objectContaining({ id: 'server-1', client_id: null }),
	])
	const [server] = (await hub.getSnapshot()).servers
	expect(server?.oauthClientId).toBe('gh-client')
	expect(server?.error).toContain('The OAuth client was saved')

	manager.registerFailuresRemaining = 1
	const removed = await setOAuthClient(hub, null)
	expect(removed.connection.lastError?.message).toContain(
		'The OAuth client was removed, but Kody could not start authorization without it',
	)
	expect(values.has(preRegisteredClientKey)).toBe(false)
})

test('overlapping client changes run one at a time and the hub keeps the last one', async () => {
	const { values, hub, manager } = createHub()
	seedServer(manager)

	const [first, second] = await Promise.all([
		setOAuthClient(hub, sealedClient('client-a')),
		setOAuthClient(hub, sealedClient('client-b')),
	])
	expect(first.previousClientId).toBeNull()
	expect(second.previousClientId).toBe('client-a')
	expect(values.get(preRegisteredClientKey)).toEqual(sealedClient('client-b'))
	expect((await hub.getSnapshot()).servers[0]?.oauthClientId).toBe('client-b')

	const removed = await setOAuthClient(hub, null)
	expect(removed).toMatchObject({
		changed: true,
		previousClientId: 'client-b',
	})
	expect(values.has(preRegisteredClientKey)).toBe(false)
	const registerCount = manager.registerCount
	const again = await setOAuthClient(hub, null)
	expect(again).toMatchObject({ changed: false, previousClientId: null })
	expect(manager.registerCount).toBe(registerCount)
	expect((await hub.getSnapshot()).servers[0]?.oauthClientId).toBeNull()
})

test('a restarted hub reads stored client ids back into snapshots', async () => {
	const { values, hub, manager } = createHub()
	seedServer(manager)
	await setOAuthClient(hub, sealedClient('gh-client'))

	const restarted = createHub()
	for (const [key, value] of values) restarted.values.set(key, value)
	seedServer(restarted.manager)
	expect((await restarted.hub.getSnapshot()).servers[0]?.oauthClientId).toBe(
		'gh-client',
	)
})

test('cold website reads do not restore legacy hubs or consume stored authorization', async () => {
	const { hub, manager, state, values } = createHub()
	seedServer(manager, {
		authUrl: 'https://provider.example/authorize?secret=hidden',
	})
	const before = {
		connects: manager.connectCount,
		discovers: manager.discoverCount,
	}
	vi.mocked(state.storage.put).mockClear()
	expect(await hub.readSnapshot()).toEqual({ servers: [] })
	expect(manager.connectCount).toBe(before.connects)
	expect(manager.discoverCount).toBe(before.discovers)
	expect(state.storage.put).not.toHaveBeenCalled()
	expect(values.has(mcpReadSnapshotStorageKey)).toBe(false)
})

test('operational snapshots persist sanitized cards and warm reads never recover or write', async () => {
	const { hub, manager, state, values } = createHub()
	const connection = await seedReadyHomeServer(hub, manager)
	const projection = values.get(mcpReadSnapshotStorageKey)
	expect(projection).toMatchObject({
		servers: [{ serverId: 'server-1', state: 'ready' }],
	})
	expect(JSON.stringify(projection)).not.toContain('authUrl')
	connection.connectionState = 'disconnected'
	const before = {
		connects: manager.connectCount,
		discovers: manager.discoverCount,
	}
	vi.mocked(state.storage.put).mockClear()
	const read = await hub.readSnapshot()
	expect(read.servers[0]?.state).not.toBe('ready')
	expect(manager.connectCount).toBe(before.connects)
	expect(manager.discoverCount).toBe(before.discovers)
	expect(state.storage.put).not.toHaveBeenCalled()
	const cold = createHub()
	cold.values.set(mcpReadSnapshotStorageKey, projection)
	expect((await cold.hub.readSnapshot()).servers[0]).toMatchObject({
		state: 'unknown',
		authorizationPending: false,
	})
	expect(cold.manager.connectCount).toBe(0)
})
