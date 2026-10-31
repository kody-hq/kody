import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as packageSourceModule from '#worker/package-registry/source.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { deliverPackageEvent } from './service.ts'
import {
	packageInvocationsRepoMockModule as repoMockModule,
	createDatabase,
	createEnv,
	seedRuntimeDispatchPackages,
	createRuntimeEventTools,
} from '#worker/test-support/package-invocations.ts'

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		repoMockModule.resolveSavedPackageRef(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByName(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		repoMockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceBySourceId(...args),
	loadPackageSourceRowForUser: (
		...args: Parameters<typeof packageSourceModule.loadPackageSourceRowForUser>
	) => repoMockModule.loadPackageSourceRowForUser(...args),
	loadPackageSourceRowsForUser: (
		...args: Parameters<typeof packageSourceModule.loadPackageSourceRowsForUser>
	) => repoMockModule.loadPackageSourceRowsForUser(...args),
	loadPackageManifestForSource: (
		...args: Parameters<typeof packageSourceModule.loadPackageManifestForSource>
	) => repoMockModule.loadPackageManifestForSource(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		repoMockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		repoMockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		repoMockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		repoMockModule.runBundledModuleWithRegistry(...args),
}))

vi.mock('#worker/usage/agent-package-conversation-uses.ts', () => ({
	recordAgentPackageConversationUse: (...args: Array<unknown>) =>
		repoMockModule.recordAgentPackageConversationUse(...args),
}))

vi.mock('#worker/run-records/package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: (...args: Array<unknown>) =>
		repoMockModule.dispatchRunErrorSubscriptionEvents(...args),
}))

const fanOutMocks = vi.hoisted(() => ({
	fanOutPackageEventToMcpSubscriptions: vi.fn(async () => ({
		status: 'skipped_not_mcp',
		delivered: 0,
		failed: 0,
		denied: 0,
	})),
}))

vi.mock('#mcp/events/fan-out.ts', () => fanOutMocks)

// Every trigger runs as its enabler; here the personal org's own person.
vi.mock('#worker/enablements/run-gate.ts', () => ({
	planEnablementRuns: async (input: { orgId: string }) => ({
		runs: [
			{
				id: `enablement-${input.orgId}`,
				enabler: { userId: input.orgId, username: 'owner' },
				role: 'owner',
			},
		],
		skipped: [],
	}),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: 'owner@example.com',
		username: 'owner',
		displayName: 'Owner',
	}),
}))

const messageCreated = '@kentcdodds/discord.message.created'

function deliver(
	db: ReturnType<typeof createDatabase>,
	message: Parameters<typeof deliverPackageEvent>[0]['message'],
) {
	return deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message,
	})
}

function failSubscriberManifestLoads(
	seed: ReturnType<typeof seedRuntimeDispatchPackages>,
) {
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-subscriber') {
				throw new Error('manifest unavailable')
			}
			return {
				source: seed.sources.get(input.sourceId),
				manifest: seed.manifests.get(input.sourceId),
			}
		},
	)
}

/** Rewrites a seeded manifest `kody` block and its package.json source file. */
function patchSeededManifest(
	seed: ReturnType<typeof seedRuntimeDispatchPackages>,
	sourceId: string,
	kody: Record<string, unknown>,
) {
	const manifest = seed.manifests.get(sourceId) as {
		kody: Record<string, unknown>
	}
	Object.assign(manifest.kody, kody)
	const files = seed.sourceFiles.get(sourceId)
	if (files) files['package.json'] = JSON.stringify(manifest)
}

test('package runtime dispatch enqueues declared events and validates payloadSchema', async () => {
	const db = createDatabase()
	const seed = seedRuntimeDispatchPackages()
	const send = vi.fn<(message: unknown) => Promise<undefined>>(
		async () => undefined,
	)
	const eventTools = (packageInvokeDepth?: number) =>
		createRuntimeEventTools(db, {
			envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
			packageInvokeDepth,
		})
	const tools = eventTools()

	const result = await tools.dispatch({
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
	})

	expect(send).toHaveBeenCalledTimes(1)
	expect(send).toHaveBeenCalledWith({
		userId: ownerIdFromStored('user-123'),
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
		emittedAt: expect.any(String),
		lineage: {
			actor: { userId: ownerIdFromStored('user-123'), username: null },
			attribution: { kind: 'user', userId: ownerIdFromStored('user-123') },
			credential: {
				kind: 'mcp-oauth',
				id: null,
				orgId: ownerIdFromStored('user-123'),
				scopes: null,
			},
			membership: { role: 'owner' },
		},
	})
	// Queued delivery never invokes subscribers inside the emitting request.
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	expect(result).toEqual({
		topic: messageCreated,
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		idempotencyKey: 'discord:message-create:123',
		status: 'enqueued',
	})

	for (const [dispatchTools, input, error] of [
		[
			tools,
			{
				topic: '@kentcdodds/discord.reaction.created',
				idempotencyKey: 'discord:reaction-create:123',
				payload: { reactionId: '123' },
			},
			/does not declare emitted event "@kentcdodds\/discord.reaction.created"/,
		],
		[
			tools,
			{
				topic: messageCreated,
				idempotencyKey: 'discord:message-create:huge',
				payload: { blob: 'x'.repeat(65 * 1024) },
			},
			/payload is \d+ bytes; the maximum is 65536 bytes/,
		],
		[
			tools,
			{
				topic: messageCreated,
				idempotencyKey: 'discord:message-create:invalid-shape',
				payload: ['not', 'an', 'object'] as never,
			},
			'events.dispatch payload must be a JSON object when provided.',
		],
		[
			eventTools(8),
			{
				topic: messageCreated,
				idempotencyKey: 'discord:message-create:deep',
				payload: {},
			},
			/exceeded the maximum nested invocation depth/,
		],
	] as const) {
		await expect(dispatchTools.dispatch(input)).rejects.toThrow(error)
	}
	expect(send).toHaveBeenCalledTimes(1)

	patchSeededManifest(seed, 'source-gateway', {
		emits: {
			[messageCreated]: {
				description: 'A Discord message was created.',
				payloadSchema: {
					type: 'object',
					properties: {
						messageId: { type: 'string', minLength: 1 },
						channelId: { type: 'string' },
					},
					required: ['messageId'],
					additionalProperties: false,
				},
			},
		},
	})
	send.mockClear()
	const schemaTools = eventTools()
	await expect(
		schemaTools.dispatch({
			topic: messageCreated,
			idempotencyKey: 'discord:message-create:bad',
			payload: { channelId: '456', extra: true },
		}),
	).rejects.toThrow(
		/payload does not match the declared payloadSchema[\s\S]*missing required property "messageId"[\s\S]*unexpected property "extra"/,
	)
	expect(send).not.toHaveBeenCalled()
	await expect(
		schemaTools.dispatch({
			topic: messageCreated,
			idempotencyKey: 'discord:message-create:ok',
			payload: { messageId: '123', channelId: '456' },
		}),
	).resolves.toMatchObject({ status: 'enqueued' })
	expect(send).toHaveBeenCalledTimes(1)

	patchSeededManifest(seed, 'source-gateway', {
		emits: {
			[messageCreated]: {
				description: 'A Discord message was created.',
				mcp: true,
			},
		},
	})
	send.mockClear()
	await eventTools().dispatch({
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:mcp',
		payload: { messageId: '123' },
	})
	expect(send).toHaveBeenCalledWith(
		expect.objectContaining({ mcp: true, emittedAt: expect.any(String) }),
	)
})

test('package event delivery fans out to MCP subscriptions on the same consumer path', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const message = {
		userId: ownerIdFromStored('user-123'),
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:mcp-fan-out',
		payload: { messageId: '123', channelId: '456' },
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
		mcp: true as const,
		emittedAt: '2026-10-07T12:00:00.000Z',
	}
	fanOutMocks.fanOutPackageEventToMcpSubscriptions.mockClear()

	await expect(deliver(db, message)).resolves.toMatchObject({
		delivered: 1,
		failed: 0,
	})
	expect(fanOutMocks.fanOutPackageEventToMcpSubscriptions).toHaveBeenCalledWith(
		{
			env: expect.anything(),
			baseUrl: expect.any(String),
			message,
		},
	)

	// An MCP fan-out failure is logged and never fails package delivery.
	consoleError.mockImplementation(() => {})
	fanOutMocks.fanOutPackageEventToMcpSubscriptions.mockRejectedValueOnce(
		new Error('fan-out exploded'),
	)
	await expect(
		deliver(db, { ...message, idempotencyKey: 'discord:mcp-fan-out-error' }),
	).resolves.toMatchObject({ delivered: 1, failed: 0 })
	expect(consoleError).toHaveBeenCalledWith(
		'mcp-events-fan-out-failed',
		expect.objectContaining({ topic: messageCreated }),
	)
})

test('package events deliver with filters, idempotent replay, and retryable failures', async () => {
	const db = createDatabase()
	const seed = seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			_bundle: unknown,
			params: Record<string, unknown> | undefined,
			options: { packageEventTools?: { dispatch?: unknown } },
		) => ({
			result: {
				received: params,
				hasEventDispatch:
					typeof options.packageEventTools?.dispatch === 'function',
			},
			logs: [],
		}),
	)
	const baseMessage = {
		userId: ownerIdFromStored('user-123'),
		topic: messageCreated,
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
	}
	const message = {
		...baseMessage,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
	}

	const first = await deliver(db, message)
	const second = await deliver(db, message)

	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toEqual({
		event: messageCreated,
		source: {
			type: 'package',
			package_id: 'pkg-gateway',
			kody_id: 'discord-gateway',
		},
		idempotency_key: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
	})
	const subscriber = {
		packageId: 'pkg-subscriber',
		kodyId: 'discord-general-chat',
	}
	expect(first).toMatchObject({
		topic: messageCreated,
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		delivered: 1,
		failed: 0,
		subscribers: [
			{
				...subscriber,
				handler: 'src/handle-discord-message-created.ts',
				status: 'completed',
			},
		],
	})
	expect(second).toMatchObject({
		delivered: 1,
		failed: 0,
		subscribers: [{ ...subscriber, status: 'replayed' }],
	})

	failSubscriberManifestLoads(seed)
	consoleWarn.mockImplementation(() => {})
	await expect(
		deliver(db, { ...message, idempotencyKey: 'discord:manifest-error' }),
	).rejects.toThrow(
		/Failed to load package manifest for package event dispatch/,
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({ packageId: 'pkg-subscriber' }),
	)

	patchSeededManifest(seedRuntimeDispatchPackages(), 'source-subscriber', {
		subscriptions: {
			[messageCreated]: {
				handler: './src/handle-discord-message-created.ts',
				filters: { channelId: '456' },
			},
		},
	})
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const filteredOut = await deliver(db, {
		...baseMessage,
		idempotencyKey: 'discord:other-channel',
		payload: { messageId: '1', channelId: '999' },
	})
	expect(filteredOut).toMatchObject({ delivered: 0, failed: 0 })
	expect(filteredOut.subscribers).toEqual([])
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	const matching = await deliver(db, {
		...baseMessage,
		idempotencyKey: 'discord:matching-channel',
		payload: { messageId: '2', channelId: '456' },
	})
	expect(matching).toMatchObject({ delivered: 1, failed: 0 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)

	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	consoleError.mockImplementation(() => {})
	await expect(
		deliver(createDatabase({ failClaim: true }), {
			...baseMessage,
			idempotencyKey: 'discord:message-create:claim-failure',
			payload: { messageId: '1' },
		}),
	).rejects.toThrow('Package event dispatch was incomplete.')
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('events.dispatch from a team package keys subscribers by the package owner org', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const send = vi.fn<(message: unknown) => Promise<undefined>>(
		async () => undefined,
	)
	const teamOrgId = ownerIdFromStored('org-acme-team')
	const tools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
		orgBinding: {
			org: { id: teamOrgId, slug: 'acme' },
			role: 'member',
		},
	})

	await tools.dispatch({
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:team',
		payload: { messageId: 'team-1' },
	})

	expect(send).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: teamOrgId,
			topic: messageCreated,
			source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		}),
	)
	expect(send.mock.calls[0]?.[0]).not.toMatchObject({
		userId: ownerIdFromStored('user-123'),
	})
	expect(repoMockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith(
		expect.objectContaining({ userId: teamOrgId }),
	)
})

test('package events fall back to inline delivery without a queue binding', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const tools = createRuntimeEventTools(db)

	const result = await tools.dispatch({
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:inline',
		payload: { messageId: 'inline-1' },
	})

	expect(result).toMatchObject({ status: 'delivered_inline' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toMatchObject({
		event: messageCreated,
		payload: { messageId: 'inline-1' },
	})

	// Inline delivery failures are logged, never surfaced to the emitter.
	failSubscriberManifestLoads(seedRuntimeDispatchPackages())
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	await expect(
		tools.dispatch({
			topic: messageCreated,
			idempotencyKey: 'discord:message-create:inline-error',
			payload: { messageId: 'inline-2' },
		}),
	).resolves.toMatchObject({ status: 'delivered_inline' })
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({ topic: messageCreated }),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-inline-delivery-failed',
		expect.objectContaining({ topic: messageCreated }),
	)
})
