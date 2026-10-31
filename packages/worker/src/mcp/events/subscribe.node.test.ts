import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { mcpEventSubscriptionsPerPrincipalMax } from './constants.ts'
import {
	subscribeMcpEvent,
	type McpEventsPrincipal,
	type McpEventsSubscribeParams,
} from './subscribe.ts'
import { getMcpEventSubscription } from './subscriptions-repo.ts'
import { unsubscribeMcpEvent } from './unsubscribe.ts'

const mocks = vi.hoisted(() => ({ listMcpEventSources: vi.fn() }))

vi.mock('./list-events.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	listMcpEventSources: (...args: Array<unknown>) =>
		mocks.listMcpEventSources(...args),
}))

const topic = '@kentcdodds/discord.message.created'
const callbackUrl = 'https://hooks.example.com/kody'
const secret = `whsec_${Buffer.alloc(32, 5).toString('base64')}`
const now = new Date('2026-10-07T12:00:00.000Z')

type CallbackRequest = {
	url: string
	headers: Record<string, string>
	body: Record<string, unknown>
}

let callbackRequests: Array<CallbackRequest> = []
let respond: (request: CallbackRequest) => Response

beforeEach(() => {
	callbackRequests = []
	respond = (request) => Response.json({ challenge: request.body['challenge'] })
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: URL | string, init: RequestInit) => {
			const request: CallbackRequest = {
				url: String(url),
				headers: init.headers as Record<string, string>,
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
			}
			callbackRequests.push(request)
			return respond(request)
		}),
	)
	mocks.listMcpEventSources.mockResolvedValue(
		new Map([[topic, { definition: { name: topic }, packageIds: ['pkg-1'] }]]),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	mocks.listMcpEventSources.mockReset()
})

function createPrincipal(
	overrides: {
		oauthClientId?: string
		userId?: string | null
		profileId?: string
	} = {},
) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const userId = overrides.userId === undefined ? 'user-1' : overrides.userId
	const principal: McpEventsPrincipal = {
		env,
		oauthClientId: overrides.oauthClientId ?? 'client-a',
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.example.com',
			profileId: overrides.profileId,
			user: userId
				? {
						userId: personIdFromStored(userId),
						email: 'one@example.com',
						displayName: 'One',
					}
				: null,
		}),
	}
	return { sqlite, env, principal }
}

function params(
	overrides: Partial<McpEventsSubscribeParams> = {},
): McpEventsSubscribeParams {
	return {
		name: topic,
		arguments: {},
		delivery: { mode: 'webhook', url: callbackUrl, secret },
		...overrides,
	}
}

test('subscribe verifies the callback with a signed challenge and stores the subscription', async () => {
	const { env, principal } = createPrincipal()
	const result = await subscribeMcpEvent(principal, params(), now)

	expect(result).toEqual({
		id: expect.stringMatching(/^sub_[0-9a-f]{32}$/),
		refreshBefore: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
		cursor: null,
		truncated: false,
	})
	expect(callbackRequests).toHaveLength(1)
	const [verification] = callbackRequests
	expect(verification).toMatchObject({
		url: callbackUrl,
		body: { type: 'verification', challenge: expect.any(String) },
		headers: {
			'Content-Type': 'application/json',
			'webhook-id': expect.stringMatching(/^msg_verification_/),
			'webhook-timestamp': expect.stringMatching(/^\d+$/),
			'webhook-signature': expect.stringMatching(/^v1,/),
			'X-MCP-Subscription-Id': result.id,
		},
	})
	await expect(
		getMcpEventSubscription({
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			id: result.id,
		}),
	).resolves.toMatchObject({
		oauthClientId: 'client-a',
		eventName: topic,
		callbackUrl,
		verifiedAt: now.toISOString(),
		active: true,
	})
	expect(mocks.listMcpEventSources).toHaveBeenCalledWith({
		env,
		callerContext: principal.callerContext,
	})
})

test('refresh reuses verification, regrants the TTL, and reports delivery status', async () => {
	const { principal } = createPrincipal()
	const created = await subscribeMcpEvent(principal, params(), now)
	const later = new Date(now.getTime() + 30 * 60 * 1000)
	const refreshed = await subscribeMcpEvent(
		principal,
		params({ ttlMs: 5 * 60 * 1000, cursor: 'opaque-cursor' }),
		later,
	)
	expect(refreshed).toEqual({
		id: created.id,
		refreshBefore: new Date(later.getTime() + 5 * 60 * 1000).toISOString(),
		cursor: null,
		truncated: true,
		deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null },
	})
	const minTtl = await subscribeMcpEvent(principal, params({ ttlMs: 0 }), later)
	expect(minTtl.id).toBe(created.id)
	expect(minTtl.refreshBefore).toBe(
		new Date(later.getTime() + 60 * 1000).toISOString(),
	)
	const maxTtl = await subscribeMcpEvent(
		principal,
		params({ ttlMs: null }),
		later,
	)
	expect(maxTtl.id).toBe(created.id)
	expect(maxTtl.refreshBefore).toBe(
		new Date(later.getTime() + 24 * 60 * 60 * 1000).toISOString(),
	)
	// A second event to the same callback reuses the cached verification.
	mocks.listMcpEventSources.mockResolvedValue(
		new Map([
			[topic, { definition: { name: topic }, packageIds: ['pkg-1'] }],
			['other.topic', { definition: { name: 'other.topic' }, packageIds: [] }],
		]),
	)
	const other = await subscribeMcpEvent(
		principal,
		params({ name: 'other.topic' }),
		later,
	)
	expect(other.id).not.toBe(created.id)
	expect(callbackRequests).toHaveLength(1)
})

test('subscribe maps each refusal to its draft error code', async () => {
	const { principal } = createPrincipal()
	const cases: Array<[McpEventsSubscribeParams, Record<string, unknown>]> = [
		[
			params({ delivery: { mode: 'poll', url: callbackUrl } }),
			{ code: -32014, data: { feature: 'deliveryMode', value: 'poll' } },
		],
		[
			params({ delivery: { mode: 'webhook', url: callbackUrl } }),
			{ code: -32602, message: expect.stringMatching(/secret is required/) },
		],
		[
			params({
				delivery: { mode: 'webhook', url: callbackUrl, secret: 'nope' },
			}),
			{ code: -32602, message: expect.stringMatching(/whsec_/) },
		],
		[
			params({
				delivery: {
					mode: 'webhook',
					url: 'http://hooks.example.com/kody',
					secret,
				},
			}),
			{ code: -32602, message: expect.stringMatching(/https/) },
		],
		[
			params({
				delivery: {
					mode: 'webhook',
					url: 'https://169.254.169.254/latest',
					secret,
				},
			}),
			{ code: -32602, message: expect.stringMatching(/IPv4/) },
		],
		[
			params({ arguments: { channelId: '1' } }),
			{ code: -32602, message: expect.stringMatching(/accepts no arguments/) },
		],
		[
			params({ name: 'unknown.topic' }),
			{ code: -32011, data: { kind: 'event', name: 'unknown.topic' } },
		],
	]
	for (const [input, expected] of cases) {
		await expect(
			subscribeMcpEvent(principal, input, now),
		).rejects.toMatchObject(expected)
	}
	expect(callbackRequests).toHaveLength(0)
})

test('subscribe requires an authenticated OAuth principal', async () => {
	const anonymous = createPrincipal({ userId: null }).principal
	await expect(
		subscribeMcpEvent(anonymous, params(), now),
	).rejects.toMatchObject({ code: -32012 })
	const noClient = createPrincipal({ oauthClientId: '' }).principal
	await expect(
		subscribeMcpEvent(noClient, params(), now),
	).rejects.toMatchObject({
		code: -32012,
	})
})

test('failed callback verification is CallbackEndpointError with a category only', async () => {
	const { env, principal } = createPrincipal()
	const outcomes: Array<[() => Response, string]> = [
		[() => Response.json({ challenge: 'wrong' }), 'challenge_failed'],
		[() => new Response('not json'), 'challenge_failed'],
		[() => new Response('boom', { status: 500 }), 'http_5xx'],
		[() => new Response('gone', { status: 410 }), 'http_4xx'],
	]
	for (const [response, reason] of outcomes) {
		respond = response
		await expect(subscribeMcpEvent(principal, params(), now)).rejects.toEqual(
			expect.objectContaining({
				code: -32015,
				data: { reason },
			}),
		)
	}
	const rows = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM mcp_event_subscriptions`,
	).first<{ count: number }>()
	expect(rows?.count).toBe(0)
})

test('new subscriptions beyond the per-principal limit are ResourceExhausted', async () => {
	const { sqlite, principal } = createPrincipal()
	const insert = sqlite.prepare(
		`INSERT INTO mcp_event_subscriptions (
			id, user_id, oauth_client_id, event_name, arguments_json, callback_url,
			secret_encrypted, refresh_before, verified_at
		) VALUES (?, 'user-1', 'client-a', ?, '{}', ?, 'x', ?, ?)`,
	)
	const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
	for (let index = 0; index < mcpEventSubscriptionsPerPrincipalMax; index++) {
		insert.run(
			`sub_seed_${index}`,
			`seed.${index}`,
			callbackUrl,
			future,
			now.toISOString(),
		)
	}
	await expect(
		subscribeMcpEvent(principal, params(), now),
	).rejects.toMatchObject({
		code: -32013,
		data: { limit: 'subscriptions', max: mcpEventSubscriptionsPerPrincipalMax },
	})
	// Expired rows are pruned first and do not count toward the limit.
	sqlite
		.prepare(
			`UPDATE mcp_event_subscriptions SET refresh_before = ? WHERE id = 'sub_seed_0'`,
		)
		.run(now.toISOString())
	await expect(
		subscribeMcpEvent(principal, params(), now),
	).resolves.toMatchObject({ id: expect.stringMatching(/^sub_/) })
})

test('unsubscribe deletes a profile-bound subscription by its profile key', async () => {
	const { env, principal } = createPrincipal({ profileId: 'profile-1' })
	const created = await subscribeMcpEvent(principal, params(), now)
	await expect(
		unsubscribeMcpEvent(principal, {
			name: topic,
			delivery: { mode: 'webhook', url: callbackUrl },
		}),
	).resolves.toEqual({})
	await expect(
		getMcpEventSubscription({
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
		}),
	).resolves.toBeNull()
})

test('unsubscribe deletes by key and is idempotent', async () => {
	const { env, principal } = createPrincipal()
	const created = await subscribeMcpEvent(principal, params(), now)
	const otherClient: McpEventsPrincipal = {
		...principal,
		oauthClientId: 'client-b',
	}
	const unsubscribeParams = {
		name: topic,
		delivery: { mode: 'webhook', url: callbackUrl },
	}
	await expect(
		unsubscribeMcpEvent(otherClient, unsubscribeParams),
	).resolves.toEqual({})
	await expect(
		getMcpEventSubscription({
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
		}),
	).resolves.not.toBeNull()

	await expect(
		unsubscribeMcpEvent(principal, unsubscribeParams),
	).resolves.toEqual({})
	await expect(
		getMcpEventSubscription({
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
		}),
	).resolves.toBeNull()
	await expect(
		unsubscribeMcpEvent(principal, unsubscribeParams),
	).resolves.toEqual({})
	await expect(
		unsubscribeMcpEvent(principal, {
			name: topic,
			delivery: { url: 'not a url' },
		}),
	).resolves.toEqual({})
})
