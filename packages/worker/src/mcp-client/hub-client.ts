import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { type McpServerConnectionEvent } from './connection-episodes.ts'
import { type McpOAuthAttemptActor } from './oauth-attempt.ts'
import { type SealedMcpPreRegisteredOAuthClient } from './preregistered-oauth-client.ts'
import {
	type McpClientHubSnapshot,
	type McpHubConnectResult,
	type McpClientHubReadSnapshot,
	type McpHubServerSnapshot,
	type McpServerConnectResult,
	type McpServerOAuthCallbackOutcome,
	type McpServerOAuthClientChange,
	type McpServerPendingAuthorization,
	type McpServerSnapshot,
} from './types.ts'

export const mcpClientHubSnapshotCacheTtlMs = 30_000
export const mcpClientHubSnapshotCacheLimit = 100

type McpClientHubClientInput = {
	env: Env
	userId: OwnerId
	waitUntil?: (promise: Promise<unknown>) => void
}

/** Cache/DO key alias for {@link mcpClientHubDurableObjectName}. */
export function mcpClientHubKey(userId: OwnerId) {
	return mcpClientHubDurableObjectName(userId)
}

function getMcpClientHubStub(input: { env: Env; userId: OwnerId }) {
	const key = mcpClientHubDurableObjectName(input.userId)
	return input.env.MCP_CLIENT_HUB.get(input.env.MCP_CLIENT_HUB.idFromName(key))
}

async function emitMcpServerConnectionEvents(input: {
	env: Env
	userId: string
	events: Array<McpServerConnectionEvent>
}): Promise<boolean> {
	if (input.events.length === 0) return true
	const { emitMcpServerConnectionEventsIfNeeded } =
		await import('./package-subscriptions.ts')
	// Await fan-out here, then ack. Do not hand `waitUntil` to the emitter:
	// that would schedule invoke and return true before packages run, and the
	// caller would ack a notice that never reached subscribers.
	return await emitMcpServerConnectionEventsIfNeeded({
		env: input.env,
		userId: input.userId,
		events: input.events,
	})
}

export type McpClientHubClient = {
	addServer(input: {
		serverId: string
		name: string
		url: string
		callbackUrl: string
		actor?: McpOAuthAttemptActor | null
		headers?: Record<string, string>
	}): Promise<McpServerConnectResult>
	reconnectServer(input: {
		serverId: string
		callbackUrl: string
		actor?: McpOAuthAttemptActor | null
	}): Promise<McpServerConnectResult>
	refreshServer(input: { serverId: string }): Promise<McpServerConnectResult>
	removeServer(input: { serverId: string }): Promise<void>
	setPreRegisteredOAuthClient(input: {
		serverId: string
		callbackUrl: string
		client: SealedMcpPreRegisteredOAuthClient | null
		actor?: McpOAuthAttemptActor | null
	}): Promise<McpServerOAuthClientChange>
	handleOAuthCallback(input: {
		url: string
		callbackUrl: string
		actor?: McpOAuthAttemptActor | null
	}): Promise<McpServerOAuthCallbackOutcome>
	bindOAuthAttemptActor(input: {
		serverId: string
		actor: McpOAuthAttemptActor
	}): Promise<{ ok: boolean }>
	getSnapshot(): Promise<McpClientHubSnapshot>
	readPendingAuthorization(input: {
		serverId: string
	}): Promise<McpServerPendingAuthorization | null>
}

/**
 * Call a tool with the org's stored MCP OAuth credentials. Only
 * `resolveCredential` may call this (credential-storage-boundary test).
 * The mcp-connection handle audits each invocation; this function does not,
 * and it must not grow an audit of arguments or return values.
 */
export async function callMcpServerTool(
	input: McpClientHubClientInput & {
		serverId: string
		toolName: string
		args: Record<string, unknown>
	},
): Promise<CallToolResult> {
	const stub = getMcpClientHubStub(input)
	try {
		const result = (await stub.callTool({
			serverId: input.serverId,
			toolName: input.toolName,
			args: input.args,
		})) as CallToolResult
		await saveReadSnapshot(input, stub)
		await emitPendingConnectionEvents(input, stub)
		return result
	} catch (error) {
		invalidateMcpClientHubSnapshotCache(input)
		await saveReadSnapshot(input, stub)
		await emitPendingConnectionEvents(input, stub)
		throw error
	}
}

async function saveReadSnapshot(
	input: McpClientHubClientInput,
	stub: ReturnType<typeof getMcpClientHubStub>,
) {
	try {
		await stub.saveReadSnapshot()
	} catch (error) {
		console.warn('mcp-read-snapshot-save-failed', error)
	} finally {
		mcpReadSnapshotCache.delete(mcpClientHubKey(input.userId))
	}
}

export function createMcpClientHubClient(
	input: McpClientHubClientInput,
): McpClientHubClient {
	const stub = getMcpClientHubStub(input)
	async function operation<T>(run: () => Promise<T>): Promise<T> {
		invalidateMcpClientHubSnapshotCache(input)
		try {
			return await run()
		} finally {
			await saveReadSnapshot(input, stub)
			invalidateMcpClientHubSnapshotCache(input)
		}
	}
	return {
		async addServer(addInput) {
			const result = await operation(() => stub.addServer(addInput))
			await emitPendingConnectionEvents(input, stub)
			return toMcpServerConnectResult(result)
		},
		async reconnectServer(reconnectInput) {
			const result = await operation(() => stub.reconnectServer(reconnectInput))
			await emitPendingConnectionEvents(input, stub)
			return toMcpServerConnectResult(result)
		},
		async refreshServer(refreshInput) {
			const result = await operation(() => stub.refreshServer(refreshInput))
			await emitPendingConnectionEvents(input, stub)
			return toMcpServerConnectResult(result)
		},
		async removeServer(removeInput) {
			await operation(() => stub.removeServer(removeInput))
		},
		async setPreRegisteredOAuthClient(clientInput) {
			const change = await operation(() =>
				stub.setPreRegisteredOAuthClient(clientInput),
			)
			await emitPendingConnectionEvents(input, stub)
			return {
				...change,
				connection: toMcpServerConnectResult(change.connection),
			}
		},
		async handleOAuthCallback(callbackInput) {
			const result = await operation(() =>
				stub.handleOAuthCallback(callbackInput),
			)
			await emitPendingConnectionEvents(input, stub)
			return result
		},
		async bindOAuthAttemptActor(bindInput) {
			return await stub.bindOAuthAttemptActor(bindInput)
		},
		async getSnapshot() {
			return getCachedMcpClientHubSnapshot(input)
		},
		async readPendingAuthorization(readInput) {
			return await stub.readPendingAuthorization(readInput)
		},
	}
}

/**
 * The provider authorization URL stays in the hub. Callers learn that
 * approval is pending and link the Kody consent page instead.
 */
export function isAuthorizationPending(result: {
	state: McpHubConnectResult['state']
	authUrl: string | null
}) {
	return result.state === 'authenticating' && Boolean(result.authUrl)
}

function toMcpServerConnectResult(
	result: McpHubConnectResult,
): McpServerConnectResult {
	const { authUrl: _authUrl, ...rest } = result
	return { ...rest, authorizationPending: isAuthorizationPending(result) }
}

function toMcpServerSnapshot(server: McpHubServerSnapshot): McpServerSnapshot {
	const { authUrl: _authUrl, ...rest } = server
	return { ...rest, authorizationPending: isAuthorizationPending(server) }
}

async function emitPendingConnectionEvents(
	input: McpClientHubClientInput,
	stub: ReturnType<typeof getMcpClientHubStub>,
	events?: Array<McpServerConnectionEvent>,
) {
	const pending =
		events ??
		((await stub.peekConnectionEvents()) as Array<McpServerConnectionEvent>)
	if (pending.length === 0) return
	const work = (async () => {
		const emitted = await emitMcpServerConnectionEvents({
			env: input.env,
			userId: input.userId,
			events: pending,
		})
		if (emitted) {
			await stub.ackConnectionEvents(pending.map((event) => event.eventId))
		}
	})()
	if (input.waitUntil) {
		input.waitUntil(work)
		return
	}
	await work
}

function createMcpClientHubSnapshotCache() {
	return new PromiseLruCache<McpClientHubSnapshot>({
		ttlMs: mcpClientHubSnapshotCacheTtlMs,
		limit: mcpClientHubSnapshotCacheLimit,
	})
}

const mcpClientHubSnapshotCache = createMcpClientHubSnapshotCache()

export function getCachedMcpClientHubSnapshot(
	input: McpClientHubClientInput,
): Promise<McpClientHubSnapshot> {
	const cacheKey = mcpClientHubKey(input.userId)
	return mcpClientHubSnapshotCache.getOrCreate({
		cacheKey,
		create: async () => {
			const stub = getMcpClientHubStub(input)
			const snapshot = await stub.getSnapshot()
			mcpReadSnapshotCache.delete(mcpClientHubKey(input.userId))
			await emitPendingConnectionEvents(
				input,
				stub,
				snapshot.connectionEvents ?? [],
			)
			return { servers: snapshot.servers.map(toMcpServerSnapshot) }
		},
	})
}

function mcpClientHubServersCacheKey(userId: OwnerId) {
	return `${mcpClientHubKey(userId)}:servers`
}

/**
 * Server cards for waiting/search. Does not observe or reconnect. A
 * token-recovery park may queue `mcp.server.disconnected`; this path
 * dispatches those pending events so subscriber packages (not a platform
 * Discord post) get the notice without waiting for an account snapshot.
 */
export function getCachedMcpClientHubServers(
	input: Pick<McpClientHubClientInput, 'env' | 'userId' | 'waitUntil'>,
): Promise<Pick<McpClientHubSnapshot, 'servers'>> {
	const cacheKey = mcpClientHubServersCacheKey(input.userId)
	return mcpClientHubSnapshotCache.getOrCreate({
		cacheKey,
		create: async () => {
			const stub = getMcpClientHubStub(input)
			const peeked = await stub.peekServers()
			await saveReadSnapshot(input, stub)
			await emitPendingConnectionEvents(input, stub)
			return { servers: peeked.servers.map(toMcpServerSnapshot) }
		},
	})
}

const mcpReadSnapshotCache = new PromiseLruCache<McpClientHubReadSnapshot>({
	ttlMs: mcpClientHubSnapshotCacheTtlMs,
	limit: mcpClientHubSnapshotCacheLimit,
})

export function getCachedMcpClientHubReadSnapshot(
	input: Pick<McpClientHubClientInput, 'env' | 'userId'>,
): Promise<McpClientHubReadSnapshot> {
	return mcpReadSnapshotCache.getOrCreate({
		cacheKey: mcpClientHubKey(input.userId),
		create: () => getMcpClientHubStub(input).readSnapshot(),
	})
}

export function invalidateMcpClientHubSnapshotCache(input: {
	userId: OwnerId
}) {
	const key = mcpClientHubKey(input.userId)
	mcpReadSnapshotCache.delete(key)
	mcpClientHubSnapshotCache.delete(key)
	mcpClientHubSnapshotCache.delete(mcpClientHubServersCacheKey(input.userId))
}
