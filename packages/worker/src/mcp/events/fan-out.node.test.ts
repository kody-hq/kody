import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { fanOutPackageEventToMcpSubscriptions } from './fan-out.ts'
import {
	buildMcpEventSubscriptionId,
	getMcpEventSubscription,
	upsertMcpEventSubscription,
} from './subscriptions-repo.ts'

vi.mock('./constants.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	mcpEventDeliveryRetryDelaysMs: [0, 0],
}))

const liveMcpMocks = vi.hoisted(() => ({
	stillExposes: true as boolean,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: vi.fn(async () =>
		liveMcpMocks.stillExposes
			? { id: 'pkg-gateway', sourceId: 'src-1', kodyId: 'discord-gateway' }
			: null,
	),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async () => ({
		manifest: {
			name: '@kentcdodds/discord-gateway',
			kody: {
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'Discord message',
						mcp: liveMcpMocks.stillExposes,
					},
				},
			},
		},
	})),
}))

const baseUrl = 'https://kody.example'

const topic = '@kentcdodds/discord.message.created'
const stableUserId = ownerIdFromStored('stable-user-1')
const now = new Date('2026-10-07T12:00:00.000Z')
const emittedAt = '2026-10-07T11:59:59.000Z'
const secret = `whsec_${Buffer.alloc(32, 3).toString('base64')}`

type ReceivedWebhook = {
	url: string
	headers: Record<string, string>
	body: string
}

const received: Array<ReceivedWebhook> = []
let flakyAttempts = 0

async function record(request: Pick<Request, 'url' | 'headers' | 'text'>) {
	received.push({
		url: request.url,
		headers: Object.fromEntries(request.headers),
		body: await request.text(),
	})
}

const network = createMswNodeServer()

beforeEach(() => {
	received.length = 0
	flakyAttempts = 0
	liveMcpMocks.stillExposes = true
	network.use(
		http.post('https://hooks.example.com/ok', async ({ request }) => {
			await record(request)
			return new HttpResponse(null, { status: 204 })
		}),
		http.post('https://hooks.example.com/flaky', async ({ request }) => {
			await record(request)
			flakyAttempts += 1
			return flakyAttempts === 1
				? new HttpResponse('try later', { status: 503 })
				: HttpResponse.json({ ok: true })
		}),
		http.post('https://hooks.example.com/gone', async ({ request }) => {
			await record(request)
			return new HttpResponse('gone', { status: 410 })
		}),
	)
})

afterEach(() => {
	network.resetHandlers()
})

afterAll(() => {
	network.close()
})

function createEnv(options: { flagEnabled?: boolean } = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (1, 'one', 'one@example.com', '${stableUserId}', 'x');
	`)
	if (options.flagEnabled ?? true) {
		sqlite.exec(`
			INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled)
			VALUES ('mcp-events-extension', 1, 1);
		`)
	}
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	return { sqlite, env }
}

async function subscribe(
	env: Env,
	input: {
		callbackUrl: string
		oauthClientId?: string
		eventName?: string
	},
) {
	const key = {
		userId: stableUserId,
		oauthClientId: input.oauthClientId ?? 'client-a',
		eventName: input.eventName ?? topic,
		arguments: {},
		callbackUrl: input.callbackUrl,
	}
	const id = await buildMcpEventSubscriptionId(key)
	await upsertMcpEventSubscription({
		db: env.APP_DB,
		env,
		id,
		key,
		secret,
		refreshBefore: new Date(now.getTime() + 60 * 60 * 1000),
		verifiedAt: now.toISOString(),
		now,
	})
	return id
}

function message(
	overrides: Partial<PackageEventsDispatchQueueMessage> = {},
): PackageEventsDispatchQueueMessage {
	return {
		userId: stableUserId,
		topic,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
		mcp: true,
		emittedAt,
		...overrides,
	}
}

function expectedSignature(webhook: ReceivedWebhook) {
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
	return `v1,${createHmac('sha256', key)
		.update(
			`${webhook.headers['webhook-id']}.${webhook.headers['webhook-timestamp']}.${webhook.body}`,
		)
		.digest('base64')}`
}

test('fan-out signs one occurrence per allowed subscription and records outcomes', async () => {
	consoleWarn.mockImplementation(() => {})
	const { env } = createEnv()
	const unlimited = await subscribe(env, {
		callbackUrl: 'https://hooks.example.com/ok',
	})
	const profiled = await subscribe(env, {
		callbackUrl: 'https://hooks.example.com/flaky',
	})
	const gone = await subscribe(env, {
		callbackUrl: 'https://hooks.example.com/gone',
	})
	await subscribe(env, {
		callbackUrl: 'https://hooks.example.com/ok',
		eventName: 'other.topic',
	})

	const result = await fanOutPackageEventToMcpSubscriptions({
		env,
		baseUrl,
		message: message(),
		now,
	})
	expect(result).toEqual({
		status: 'fanned_out',
		delivered: 2,
		failed: 1,
		denied: 0,
	})

	const okWebhooks = received.filter(
		(webhook) => webhook.url === 'https://hooks.example.com/ok',
	)
	expect(okWebhooks).toHaveLength(1)
	const [okWebhook] = okWebhooks
	expect(okWebhook!.headers).toMatchObject({
		'content-type': 'application/json',
		'webhook-id': expect.stringMatching(/^evt_[0-9a-f]{32}$/),
		'webhook-timestamp': expect.stringMatching(/^\d+$/),
		'x-mcp-subscription-id': unlimited,
	})
	expect(okWebhook!.headers['webhook-signature']).toBe(
		expectedSignature(okWebhook!),
	)
	expect(JSON.parse(okWebhook!.body)).toEqual({
		eventId: okWebhook!.headers['webhook-id'],
		name: topic,
		timestamp: emittedAt,
		data: { messageId: '123', channelId: '456' },
		cursor: null,
	})

	// 503 is retried; 410 is not.
	expect(
		received.filter((webhook) => webhook.url.endsWith('/flaky')),
	).toHaveLength(2)
	expect(
		received.filter((webhook) => webhook.url.endsWith('/gone')),
	).toHaveLength(1)
	const eventIds = new Set(
		received.map((webhook) => webhook.headers['webhook-id']),
	)
	expect(eventIds.size).toBe(1)

	const read = (id: string) =>
		getMcpEventSubscription({ db: env.APP_DB, userId: stableUserId, id })
	await expect(read(unlimited)).resolves.toMatchObject({
		lastDeliveryAt: expect.any(String),
		lastError: null,
	})
	await expect(read(profiled)).resolves.toMatchObject({
		lastDeliveryAt: expect.any(String),
		lastError: null,
	})
	await expect(read(gone)).resolves.toMatchObject({
		lastDeliveryAt: null,
		lastError: 'http_4xx',
		active: true,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp-event-delivery-failed',
		expect.objectContaining({
			subscriptionId: gone,
			topic,
			error: 'http_4xx',
			attempts: 1,
		}),
	)
})

test('queue redelivery re-sends with the same webhook-id for receiver dedupe', async () => {
	const { env } = createEnv()
	await subscribe(env, { callbackUrl: 'https://hooks.example.com/ok' })
	await fanOutPackageEventToMcpSubscriptions({
		env,
		baseUrl,
		message: message(),
		now,
	})
	await fanOutPackageEventToMcpSubscriptions({
		env,
		baseUrl,
		message: message(),
		now,
	})
	await fanOutPackageEventToMcpSubscriptions({
		env,
		baseUrl,
		message: message({ idempotencyKey: 'discord:message-create:456' }),
		now,
	})
	const ids = received.map((webhook) => webhook.headers['webhook-id'])
	expect(ids).toHaveLength(3)
	expect(ids[0]).toBe(ids[1])
	expect(ids[2]).not.toBe(ids[0])
})

test('fan-out is a no-op without mcp: true, without subscriptions, or with the flag off', async () => {
	const { env } = createEnv()
	await expect(
		fanOutPackageEventToMcpSubscriptions({
			env,
			baseUrl,
			message: message({ mcp: undefined }),
			now,
		}),
	).resolves.toMatchObject({ status: 'skipped_not_mcp' })
	await expect(
		fanOutPackageEventToMcpSubscriptions({
			env,
			baseUrl,
			message: message(),
			now,
		}),
	).resolves.toMatchObject({ status: 'no_subscriptions' })

	const flagOff = createEnv({ flagEnabled: false }).env
	await subscribe(flagOff, { callbackUrl: 'https://hooks.example.com/ok' })
	await expect(
		fanOutPackageEventToMcpSubscriptions({
			env: flagOff,
			baseUrl,
			message: message(),
			now,
		}),
	).resolves.toEqual({
		status: 'skipped_flag_off',
		delivered: 0,
		failed: 0,
		denied: 0,
	})

	const expiredEnv = createEnv().env
	await subscribe(expiredEnv, { callbackUrl: 'https://hooks.example.com/ok' })
	await expect(
		fanOutPackageEventToMcpSubscriptions({
			env: expiredEnv,
			baseUrl,
			message: message(),
			now: new Date(now.getTime() + 2 * 60 * 60 * 1000),
		}),
	).resolves.toMatchObject({ status: 'no_subscriptions' })
	expect(received).toHaveLength(0)
})

test('fan-out skips when the live package no longer declares mcp: true', async () => {
	const { env } = createEnv()
	await subscribe(env, { callbackUrl: 'https://hooks.example.com/ok' })
	liveMcpMocks.stillExposes = false
	await expect(
		fanOutPackageEventToMcpSubscriptions({
			env,
			baseUrl,
			message: message(),
			now,
		}),
	).resolves.toMatchObject({ status: 'skipped_not_mcp', delivered: 0 })
	expect(received).toHaveLength(0)
})
