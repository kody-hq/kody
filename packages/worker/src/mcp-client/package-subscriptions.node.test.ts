import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import type * as packageInvocationsModule from '#worker/package-invocations/service.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	mcpServerDisconnectedTopic,
	mcpServerReconnectedTopic,
	type McpServerConnectionEvent,
} from './connection-episodes.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn<
		typeof packageInvocationsModule.invokePackageSubscription
	>(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listEnabledMcpServerSettingRows: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('./settings-repo.ts', () => ({
	listEnabledMcpServerSettingRows: mocks.listEnabledMcpServerSettingRows,
}))

const {
	dispatchMcpServerConnectionSubscriptionEvents,
	emitMcpServerConnectionEventsIfNeeded,
} = await import('./package-subscriptions.ts')

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env
}

const savedPackage = {
	id: 'package-1',
	userId: ownerIdFromStored('user-1'),
	sourceId: 'source-1',
	kodyId: 'home-watch',
	name: '@user/home-watch',
}

const disconnectedEvent: McpServerConnectionEvent = {
	topic: mcpServerDisconnectedTopic,
	eventId: 'event-1',
	episodeId: 'episode-1',
	serverId: 'server-home',
	serverName: 'home',
	state: 'disconnected',
	previousState: 'ready',
	observedAt: '2026-08-18T17:54:07.000Z',
}

function seedSubscribedPackage(topic: string) {
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/home-watch',
			kody: {
				id: 'home-watch',
				description: 'Home MCP notifier',
				subscriptions: { [topic]: { handler: './src/on-mcp-server.ts' } },
			},
		},
	})
}

function emit(event: McpServerConnectionEvent = disconnectedEvent) {
	return emitMcpServerConnectionEventsIfNeeded({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
		events: [event],
	})
}

test('mcp.server.disconnected fans out a lean same-user payload', async () => {
	seedSubscribedPackage(mcpServerDisconnectedTopic)

	const results = await dispatchMcpServerConnectionSubscriptionEvents({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
		event: disconnectedEvent,
	})

	expect(results.complete).toBe(true)
	expect(results.results).toHaveLength(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: mcpServerDisconnectedTopic,
			idempotencyKey: `mcp-server:${mcpServerDisconnectedTopic}:episode-1:package-1`,
			source: 'mcp-client',
			params: {
				event: mcpServerDisconnectedTopic,
				event_id: 'event-1',
				server: {
					id: 'server-home',
					name: 'home',
					state: 'disconnected',
					previous_state: 'ready',
					episode_id: 'episode-1',
				},
				observed_at: '2026-08-18T17:54:07.000Z',
				account_url: 'https://example.com/@ada/-/mcp-servers/server-home',
			},
		}),
	)
	const params = mocks.invokePackageSubscription.mock.calls[0]?.[0]?.params as
		| Record<string, unknown>
		| undefined
	expect(params).not.toHaveProperty('url')
	expect(params).not.toHaveProperty('authUrl')
	expect(params).not.toHaveProperty('access_token')
	expect(JSON.stringify(params)).not.toContain('Bearer')
})

test('mcp.server connection events skip disabled servers and never throw', async () => {
	consoleWarn.mockImplementation(() => {})
	const enabledHome = () =>
		mocks.listEnabledMcpServerSettingRows.mockResolvedValueOnce([
			{ id: 'server-home' },
		])
	const eventContext = {
		eventId: 'event-1',
		topic: mcpServerDisconnectedTopic,
		serverName: 'home',
	}

	mocks.listEnabledMcpServerSettingRows.mockResolvedValueOnce([])
	await emit()
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()

	enabledHome()
	mocks.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	await expect(emit()).resolves.toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp.server connection package subscription discovery incomplete',
		expect.objectContaining(eventContext),
	)

	enabledHome()
	seedSubscribedPackage(mcpServerReconnectedTopic)
	await emit({
		...disconnectedEvent,
		topic: mcpServerReconnectedTopic,
		state: 'ready',
		previousState: 'disconnected',
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({ topic: mcpServerReconnectedTopic }),
	)

	mocks.listEnabledMcpServerSettingRows.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	await expect(emit()).resolves.toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp.server connection event enabled-server lookup failed',
		expect.objectContaining({ error: expect.any(Error) }),
	)

	enabledHome()
	seedSubscribedPackage(mcpServerDisconnectedTopic)
	mocks.invokePackageSubscription.mockResolvedValueOnce({
		status: 503,
		body: { error: { code: 'idempotency_lookup_failed' } },
	})
	await expect(emit()).resolves.toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp.server connection package subscription invoke failed',
		expect.objectContaining(eventContext),
	)
})
