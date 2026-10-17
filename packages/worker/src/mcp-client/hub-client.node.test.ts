import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	type McpServerConnectionEvent,
	mcpServerDisconnectedTopic,
} from './connection-episodes.ts'
import {
	getCachedMcpClientHubServers,
	getCachedMcpClientHubReadSnapshot,
	createMcpClientHubClient,
	getCachedMcpClientHubSnapshot,
	invalidateMcpClientHubSnapshotCache,
} from './hub-client.ts'
import type * as packageSubscriptionsModule from './package-subscriptions.ts'
import { type McpHubServerSnapshot, type McpHubSnapshot } from './types.ts'

const mocks = vi.hoisted(() => ({
	readSnapshot: vi.fn(async () => ({ servers: [] })),
	saveReadSnapshot: vi.fn(async () => undefined),
	removeServer: vi.fn(async () => undefined),
	emitMcpServerConnectionEventsIfNeeded: vi.fn<
		typeof packageSubscriptionsModule.emitMcpServerConnectionEventsIfNeeded
	>(async () => true),
	peekServers: vi.fn<() => Promise<Pick<McpHubSnapshot, 'servers'>>>(
		async () => ({ servers: [] }),
	),
	peekConnectionEvents: vi.fn<() => Promise<Array<McpServerConnectionEvent>>>(
		async () => [],
	),
	ackConnectionEvents: vi.fn<(eventIds: Array<string>) => Promise<void>>(
		async () => undefined,
	),
	getSnapshot: vi.fn<() => Promise<McpHubSnapshot>>(async () => ({
		servers: [],
		connectionEvents: [],
	})),
}))

vi.mock('./package-subscriptions.ts', () => ({
	emitMcpServerConnectionEventsIfNeeded: (
		...args: Parameters<
			typeof packageSubscriptionsModule.emitMcpServerConnectionEventsIfNeeded
		>
	) => mocks.emitMcpServerConnectionEventsIfNeeded(...args),
}))

const event: McpServerConnectionEvent = {
	topic: mcpServerDisconnectedTopic,
	eventId: 'event-1',
	episodeId: 'episode-1',
	serverId: 'server-home',
	serverName: 'home',
	state: 'authenticating',
	previousState: 'ready',
	observedAt: '2026-09-15T01:46:00.000Z',
}

function createServerSnapshot(
	overrides: Partial<McpHubServerSnapshot> = {},
): McpHubServerSnapshot {
	return {
		serverId: 'server-home',
		name: 'home',
		url: 'https://home.example/mcp',
		state: 'ready',
		authUrl: null,
		error: null,
		instructions: null,
		tools: [],
		...overrides,
	}
}

function createEnv() {
	const stub = {
		readSnapshot: mocks.readSnapshot,
		saveReadSnapshot: mocks.saveReadSnapshot,
		removeServer: mocks.removeServer,
		peekServers: mocks.peekServers,
		peekConnectionEvents: mocks.peekConnectionEvents,
		ackConnectionEvents: mocks.ackConnectionEvents,
		getSnapshot: mocks.getSnapshot,
	}
	return {
		MCP_CLIENT_HUB: { idFromName: (name: string) => name, get: () => stub },
	} as unknown as Env
}

function resetHub(userId = 'user-1') {
	invalidateMcpClientHubSnapshotCache({ userId: ownerIdFromStored(userId) })
	mocks.emitMcpServerConnectionEventsIfNeeded.mockClear()
	mocks.ackConnectionEvents.mockClear()
}

function queueAuthenticatingPeek() {
	mocks.peekServers.mockResolvedValueOnce({
		servers: [
			createServerSnapshot({
				state: 'authenticating',
				authUrl: 'https://auth.example/authorize?client_id=kody',
			}),
		],
	})
	mocks.peekConnectionEvents.mockResolvedValueOnce([event])
}

test('waiting peek dispatches a queued mcp.server.disconnected before ack', async () => {
	resetHub()
	queueAuthenticatingPeek()
	const waitUntil = vi.fn()
	const env = createEnv()

	const peeked = await getCachedMcpClientHubServers({
		env,
		userId: ownerIdFromStored('user-1'),
		waitUntil,
	})
	expect(peeked.servers[0]).toMatchObject({
		serverId: 'server-home',
		state: 'authenticating',
		authorizationPending: true,
	})
	expect(JSON.stringify(peeked)).not.toContain('auth.example')
	expect(waitUntil).toHaveBeenCalledTimes(1)
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).not.toHaveBeenCalled()
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()

	await waitUntil.mock.calls[0]?.[0]
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		events: [event],
	})
	expect(mocks.ackConnectionEvents).toHaveBeenCalledTimes(1)
	expect(mocks.ackConnectionEvents).toHaveBeenCalledWith(['event-1'])

	mocks.peekServers.mockClear()
	mocks.peekConnectionEvents.mockClear()
	const cached = await getCachedMcpClientHubServers({
		env,
		userId: ownerIdFromStored('user-1'),
		waitUntil,
	})
	expect(cached.servers[0]?.serverId).toBe('server-home')
	expect(mocks.peekServers).not.toHaveBeenCalled()
	expect(mocks.peekConnectionEvents).not.toHaveBeenCalled()

	resetHub()
	mocks.getSnapshot.mockResolvedValueOnce({
		servers: [createServerSnapshot({ state: 'ready' })],
		connectionEvents: [],
	})
	const snapshot = await getCachedMcpClientHubSnapshot({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(snapshot.servers[0]?.state).toBe('ready')
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).not.toHaveBeenCalled()
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()

	resetHub('user-2')
	queueAuthenticatingPeek()
	await getCachedMcpClientHubServers({
		env,
		userId: ownerIdFromStored('user-2'),
	})
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-2'),
		events: [event],
	})
	expect(mocks.ackConnectionEvents).toHaveBeenCalledTimes(1)
	expect(mocks.ackConnectionEvents).toHaveBeenCalledWith(['event-1'])
})

test('waiting peek does not ack when dispatch reports incomplete', async () => {
	resetHub('user-incomplete')
	mocks.emitMcpServerConnectionEventsIfNeeded.mockResolvedValueOnce(false)
	queueAuthenticatingPeek()
	await getCachedMcpClientHubServers({
		env: createEnv(),
		userId: ownerIdFromStored('user-incomplete'),
	})
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).toHaveBeenCalledTimes(1)
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()
})

test('website snapshots do not observe, deliver events, or persist and writes invalidate them', async () => {
	resetHub('read-only')
	const input = { env: createEnv(), userId: ownerIdFromStored('read-only') }
	vi.clearAllMocks()
	await getCachedMcpClientHubReadSnapshot(input)
	await getCachedMcpClientHubReadSnapshot(input)
	expect(mocks.readSnapshot).toHaveBeenCalledTimes(1)
	expect(mocks.getSnapshot).not.toHaveBeenCalled()
	expect(mocks.peekServers).not.toHaveBeenCalled()
	expect(mocks.peekConnectionEvents).not.toHaveBeenCalled()
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).not.toHaveBeenCalled()
	expect(mocks.saveReadSnapshot).not.toHaveBeenCalled()
	await createMcpClientHubClient(input).removeServer({
		serverId: 'server-home',
	})
	expect(mocks.saveReadSnapshot).toHaveBeenCalledTimes(1)
	await getCachedMcpClientHubReadSnapshot(input)
	expect(mocks.readSnapshot).toHaveBeenCalledTimes(2)
})

test('failed operation still refreshes the projection and discards cached website status', async () => {
	const input = { env: createEnv(), userId: ownerIdFromStored('lost-response') }
	invalidateMcpClientHubSnapshotCache(input)
	vi.clearAllMocks()
	await getCachedMcpClientHubReadSnapshot(input)
	mocks.removeServer.mockRejectedValueOnce(new Error('Response lost'))
	await expect(
		createMcpClientHubClient(input).removeServer({ serverId: 'server-home' }),
	).rejects.toThrow('Response lost')
	expect(mocks.saveReadSnapshot).toHaveBeenCalledTimes(1)
	await getCachedMcpClientHubReadSnapshot(input)
	expect(mocks.readSnapshot).toHaveBeenCalledTimes(2)
})
