import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyCreditPayment } from '#worker/billing/credit-wallet.ts'
import { createOpenApiTestHarness } from '#worker/test-support/open-api-http.ts'

// Saturday 22:34 UTC: the daily meter resets in 1h 26m.
const now = new Date('2026-10-10T22:34:00.000Z')

beforeEach(() => {
	vi.useFakeTimers({ now, toFake: ['Date'] })
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

async function createPurchasableProApi(wallet: 'empty' | 'funded') {
	const api = await createOpenApiTestHarness()
	api.sqlite
		.prepare(
			`UPDATE orgs SET stripe_plan = 'pro', stripe_credits_eligible = 1 WHERE id = ?`,
		)
		.run(api.userId)
	if (wallet === 'funded') {
		await applyCreditPayment({
			db: api.db,
			userId: api.userId,
			kind: 'top_up',
			amountCents: 1_000,
			stripeReference: 'pi_outbound_ceiling',
			now,
		})
	}
	const token = await api.mint(['org:execute', 'package:execute'])
	return { api, token }
}

async function seedOutboundToday(
	api: Awaited<ReturnType<typeof createOpenApiTestHarness>>,
	count: number,
) {
	await api.userMeter.seed({
		userId: api.userId,
		resource: 'outbound_fetches_per_day',
		day: utcDayKey(now),
		count,
	})
}

function gatewayFetch(
	api: Awaited<ReturnType<typeof createOpenApiTestHarness>>,
	token: string,
) {
	return api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: {
			path: ['kody', 'gatewayFetch'],
			args: [{ request: { url: 'https://api.github.com/rate_limit' } }],
		},
	})
}

test('a funded Pro org keeps fetching past 80,000 a day', async () => {
	const { api, token } = await createPurchasableProApi('funded')
	const upstream = vi.fn(async () => new Response('{"ok":true}'))
	vi.stubGlobal('fetch', upstream)
	await seedOutboundToday(api, 80_000)

	const response = await gatewayFetch(api, token)

	expect(response.status).toBe(200)
	expect(upstream).toHaveBeenCalledTimes(1)
})

test('a funded Pro org stops at 50x its include', async () => {
	const { api, token } = await createPurchasableProApi('funded')
	const upstream = vi.fn(async () => new Response('{"ok":true}'))
	vi.stubGlobal('fetch', upstream)
	await seedOutboundToday(api, 750_000)

	const denied = await gatewayFetch(api, token)

	expect(denied.status).toBe(429)
	expect(denied.body.error?.message).toMatch(/outbound fetches per day/)
	expect(denied.body.error?.message).toContain('750000')
	expect(denied.body.error?.message).toContain('1h 26m')
	expect(denied.body.error?.message).not.toMatch(/Add credits/)
	expect(upstream).not.toHaveBeenCalled()
})

test('an empty-wallet Pro org keeps its include and is told to add credits', async () => {
	const { api, token } = await createPurchasableProApi('empty')
	const upstream = vi.fn(async () => new Response('{"ok":true}'))
	vi.stubGlobal('fetch', upstream)

	await seedOutboundToday(api, 15_000)
	const denied = await gatewayFetch(api, token)
	expect(denied.status).toBe(429)
	expect(denied.body.error?.message).toMatch(/outbound fetches per day/)
	expect(denied.body.error?.message).toContain('15000')
	expect(denied.body.error?.message).toContain('1h 26m')
	expect(denied.body.error?.message).toMatch(/Add credits/)
	expect(upstream).not.toHaveBeenCalled()
})
