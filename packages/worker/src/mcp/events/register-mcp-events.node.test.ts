import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	Client,
	type ClientCapabilities,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type FeatureFlagKey } from '#universal/feature-flags/registry.ts'
import { registerMcpEvents } from './register-mcp-events.ts'

const mocks = vi.hoisted(() => ({
	resolveCallerFeatureFlagEvaluations: vi.fn(),
	recordMcpEventsClientsFlagExposure: vi.fn(),
	listMcpEventSources: vi.fn(),
	subscribeMcpEvent: vi.fn(),
	unsubscribeMcpEvent: vi.fn(),
}))

vi.mock('#mcp/capabilities/access-control.ts', () => ({
	resolveCallerFeatureFlagEvaluations: (...args: Array<unknown>) =>
		mocks.resolveCallerFeatureFlagEvaluations(...args),
}))

vi.mock('#worker/feature-flags/mcp-events-clients-exposure.ts', () => ({
	recordMcpEventsClientsFlagExposure: (...args: Array<unknown>) =>
		mocks.recordMcpEventsClientsFlagExposure(...args),
}))

vi.mock('./subscribe.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	subscribeMcpEvent: (...args: Array<unknown>) =>
		mocks.subscribeMcpEvent(...args),
}))

vi.mock('./unsubscribe.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	unsubscribeMcpEvent: (...args: Array<unknown>) =>
		mocks.unsubscribeMcpEvent(...args),
}))

vi.mock('./list-events.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	listMcpEventSources: (...args: Array<unknown>) =>
		mocks.listMcpEventSources(...args),
}))

const callerContext = createMcpCallerContext({
	source: { kind: 'mcp-oauth' },
	baseUrl: 'https://kody.example.com',
	user: {
		userId: personIdFromStored('stable-user-1'),
		email: 'one@example.com',
		displayName: 'One',
	},
})

const legacyEventsDeclaration: ClientCapabilities = {
	extensions: { 'io.modelcontextprotocol/events': {} },
}

const subscribeParams = {
	name: '@fake-user/discord.message.created',
	delivery: {
		mode: 'webhook',
		url: 'https://callback.example.com/mcp-events',
		secret: 'whsec_fake',
	},
}

const subscribeResultSchema = z.object({ id: z.string() }).loose()

const eventsListResultSchema = z.object({
	events: z.array(z.object({ name: z.string() }).loose()),
})

function evaluations(enabled: boolean) {
	return {
		'demo-indicator': { enabled: false, source: 'default' },
		'mcp-skills-extension': { enabled: false, source: 'default' },
		'mcp-events-extension': { enabled, source: 'default' },
	} as Record<FeatureFlagKey, { enabled: boolean; source: 'default' }>
}

async function connectModernClient(input: {
	clientCapabilities?: ClientCapabilities
	oauthClientId?: string | null
}) {
	const registered: Array<boolean> = []
	const discoverCapabilities: Array<unknown> = []
	const handler = createMcpHandler(
		async () => {
			const server = new McpServer({ name: 'kody-mcp', version: '1.0.0' })
			registered.push(
				await registerMcpEvents({
					server,
					env: { APP_DB: {} } as Env,
					callerContext,
					oauthClientId:
						input.oauthClientId === undefined
							? 'client-a'
							: input.oauthClientId,
				}),
			)
			return server
		},
		{ legacy: 'reject' },
	)
	const client = new Client(
		{ name: 'events-test-client', version: '1.0.0' },
		{
			versionNegotiation: { mode: { pin: '2026-07-28' } },
			...(input.clientCapabilities
				? { capabilities: input.clientCapabilities }
				: {}),
		},
	)
	const transport = new StreamableHTTPClientTransport(
		new URL('https://kody.example.com/mcp'),
		{
			fetch: async (url, init) => {
				const request = new Request(url, init)
				const parsedBody: unknown = await request.clone().json()
				const response = await handler.fetch(request, { parsedBody })
				// The client's typed ServerCapabilities strips unknown keys, so
				// read the advertised capabilities off the wire.
				if (request.headers.get('Mcp-Method') === 'server/discover') {
					const body = (await response.clone().json()) as {
						result?: { capabilities?: unknown }
					}
					discoverCapabilities.push(body.result?.capabilities)
				}
				return response
			},
		},
	)
	await client.connect(transport)
	return {
		client,
		registered,
		discoverCapabilities,
		async listEvents() {
			return await client.request(
				{ method: 'events/list', params: {} },
				eventsListResultSchema,
			)
		},
		async subscribe() {
			return await client.request(
				{ method: 'events/subscribe', params: subscribeParams },
				subscribeResultSchema,
			)
		},
		async unsubscribe() {
			return await client.request(
				{ method: 'events/unsubscribe', params: subscribeParams },
				z.object({}),
			)
		},
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => undefined)
		},
	}
}

async function expectMethodNotFound(promise: Promise<unknown>) {
	await expect(promise).rejects.toMatchObject({
		data: { text: expect.stringContaining('"code":-32601') },
	})
}

afterEach(() => {
	mocks.resolveCallerFeatureFlagEvaluations.mockReset()
	mocks.recordMcpEventsClientsFlagExposure.mockReset()
	mocks.listMcpEventSources.mockReset()
	mocks.subscribeMcpEvent.mockReset()
	mocks.unsubscribeMcpEvent.mockReset()
})

const discordMessageCreated = {
	name: '@fake-user/discord.message.created',
	description: 'A Discord message was created.',
	delivery: ['webhook'],
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	payloadSchema: { type: 'object' },
}

function expectNothingAdvertised(connection: {
	registered: Array<boolean>
	discoverCapabilities: Array<unknown>
}) {
	expect(connection.registered).not.toHaveLength(0)
	expect(connection.registered.every((value) => value === false)).toBe(true)
	expect(connection.discoverCapabilities).not.toHaveLength(0)
	for (const capabilities of connection.discoverCapabilities) {
		expect(capabilities).not.toHaveProperty('events')
	}
}

test('OAuth caller with the flag on and no client declaration gets events advertised, listed, and subscribable', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(evaluations(true))
	mocks.listMcpEventSources.mockResolvedValue(
		new Map([
			[
				discordMessageCreated.name,
				{ definition: discordMessageCreated, packageIds: ['pkg-1'] },
			],
		]),
	)
	mocks.subscribeMcpEvent.mockResolvedValue({
		id: 'sub_fake',
		refreshBefore: null,
		cursor: null,
		truncated: true,
	})
	await using connection = await connectModernClient({})

	expect(connection.registered.at(-1)).toBe(true)
	expect(connection.discoverCapabilities.at(-1)).toMatchObject({
		events: {},
	})
	expect(mocks.recordMcpEventsClientsFlagExposure).not.toHaveBeenCalled()

	await expect(connection.listEvents()).resolves.toEqual({
		events: [discordMessageCreated],
	})
	expect(mocks.listMcpEventSources).toHaveBeenCalledWith({
		env: expect.anything(),
		callerContext,
	})
	expect(mocks.recordMcpEventsClientsFlagExposure).toHaveBeenCalledWith(
		expect.objectContaining({
			stableUserId: ownerIdFromStored('stable-user-1'),
			evaluation: expect.objectContaining({ enabled: true }),
		}),
	)

	await expect(connection.subscribe()).resolves.toMatchObject({
		id: 'sub_fake',
	})
	expect(mocks.subscribeMcpEvent).toHaveBeenCalledWith(
		expect.objectContaining({ callerContext, oauthClientId: 'client-a' }),
		expect.objectContaining({ name: discordMessageCreated.name }),
	)
})

test('events/subscribe as the first events call records exposure before subscribing', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(evaluations(true))
	mocks.subscribeMcpEvent.mockImplementation(async () => {
		expect(mocks.recordMcpEventsClientsFlagExposure).toHaveBeenCalledTimes(1)
		return {
			id: 'sub_fake',
			refreshBefore: null,
			cursor: null,
			truncated: true,
		}
	})
	await using connection = await connectModernClient({})

	await expect(connection.subscribe()).resolves.toMatchObject({
		id: 'sub_fake',
	})
	expect(mocks.subscribeMcpEvent).toHaveBeenCalledTimes(1)
	expect(mocks.listMcpEventSources).not.toHaveBeenCalled()
})

test('events/unsubscribe as the first events call records exposure before unsubscribing', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(evaluations(true))
	mocks.unsubscribeMcpEvent.mockImplementation(async () => {
		expect(mocks.recordMcpEventsClientsFlagExposure).toHaveBeenCalledTimes(1)
		return {}
	})
	await using connection = await connectModernClient({})

	await expect(connection.unsubscribe()).resolves.toEqual({})
	expect(mocks.unsubscribeMcpEvent).toHaveBeenCalledTimes(1)
	expect(mocks.listMcpEventSources).not.toHaveBeenCalled()
	expect(mocks.subscribeMcpEvent).not.toHaveBeenCalled()
})

test('a client that still declares events support keeps working', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(evaluations(true))
	mocks.listMcpEventSources.mockResolvedValue(new Map())
	await using connection = await connectModernClient({
		clientCapabilities: legacyEventsDeclaration,
	})

	expect(connection.discoverCapabilities.at(-1)).toMatchObject({
		events: {},
	})
	await expect(connection.listEvents()).resolves.toEqual({ events: [] })
})

test('flag off: nothing advertised, listed, or subscribable', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(
		evaluations(false),
	)
	await using connection = await connectModernClient({})

	expectNothingAdvertised(connection)
	await expectMethodNotFound(connection.listEvents())
	await expectMethodNotFound(connection.subscribe())
	expect(mocks.listMcpEventSources).not.toHaveBeenCalled()
	expect(mocks.subscribeMcpEvent).not.toHaveBeenCalled()
	expect(mocks.recordMcpEventsClientsFlagExposure).not.toHaveBeenCalled()
})

test('flag off ignores a client events declaration', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(
		evaluations(false),
	)
	await using connection = await connectModernClient({
		clientCapabilities: legacyEventsDeclaration,
	})

	expectNothingAdvertised(connection)
	await expectMethodNotFound(connection.listEvents())
	expect(mocks.listMcpEventSources).not.toHaveBeenCalled()
})

test('flag evaluation failure fails closed', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(null)
	await using connection = await connectModernClient({})

	expectNothingAdvertised(connection)
	await expectMethodNotFound(connection.listEvents())
	await expectMethodNotFound(connection.subscribe())
	expect(mocks.recordMcpEventsClientsFlagExposure).not.toHaveBeenCalled()
})

test('non-OAuth caller with the flag on: nothing advertised, listed, or subscribable', async () => {
	mocks.resolveCallerFeatureFlagEvaluations.mockResolvedValue(evaluations(true))
	await using connection = await connectModernClient({ oauthClientId: null })

	expectNothingAdvertised(connection)
	await expectMethodNotFound(connection.listEvents())
	await expectMethodNotFound(connection.subscribe())
	expect(mocks.resolveCallerFeatureFlagEvaluations).not.toHaveBeenCalled()
	expect(mocks.subscribeMcpEvent).not.toHaveBeenCalled()
})
