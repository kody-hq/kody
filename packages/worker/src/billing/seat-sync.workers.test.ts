import { env } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { syncOrgSeatQuantity } from './seat-sync.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function stubStripeFetch(
	handler: (url: string, init?: RequestInit) => Response,
) {
	const fetchStub = vi.fn(
		async (request: RequestInfo | URL, init?: RequestInit) =>
			handler(String(request), init),
	)
	vi.stubGlobal('fetch', fetchStub)
	return Object.assign(fetchStub, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

async function seedPaidOrg(input: {
	orgId: string
	stripeCustomerId: string
	seatRoles: Array<'owner' | 'member' | 'billing'>
	plan?: string
	stripePlan?: string | null
}) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
			id, slug, plan, stripe_plan, stripe_customer_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.orgId,
			`org-${input.orgId.slice(0, 8)}`,
			input.plan ?? 'pro',
			input.stripePlan ?? null,
			input.stripeCustomerId,
			now,
			now,
		)
		.run()
	for (const [index, role] of input.seatRoles.entries()) {
		const memberId = `${input.orgId}-member-${index}`
		await env.APP_DB.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES (?, ?, 'test-password-hash', ?)`,
		)
			.bind(
				`seat-${crypto.randomUUID().slice(0, 8)}`,
				`${memberId}-${crypto.randomUUID().slice(0, 8)}@example.com`,
				memberId,
			)
			.run()
		await env.APP_DB.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
			.bind(input.orgId, memberId, role, now)
			.run()
	}
}

test('syncOrgSeatQuantity updates seats for Stripe-paid orgs with a free manual plan', async () => {
	const orgId = testStableUserIdFromEmail('stripe-paid-seat-sync@example.com')
	await seedPaidOrg({
		orgId,
		stripeCustomerId: 'cus_stripe_paid_seats',
		seatRoles: ['owner', 'member', 'member'],
		plan: 'free',
		stripePlan: 'pro',
	})
	using fetchStub = stubStripeFetch((url) => {
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse({
				data: [
					{
						id: 'sub_stripe_paid',
						status: 'active',
						cancel_at: null,
						items: {
							data: [
								{
									id: 'si_stripe_paid',
									quantity: 1,
									price: { id: 'price_pro' },
								},
							],
						},
					},
				],
			})
		}
		if (url.includes('/v1/subscription_items/si_stripe_paid')) {
			return jsonResponse({ id: 'si_stripe_paid', quantity: 3 })
		}
		return jsonResponse({ error: 'unexpected path' }, 500)
	})
	const result = await syncOrgSeatQuantity({
		db: env.APP_DB,
		env: {
			STRIPE_SECRET_KEY: 'sk_test',
			STRIPE_API_BASE_URL: 'https://stripe.mock',
			STRIPE_PRO_PRICE_ID: 'price_pro',
			STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		},
		orgId,
	})
	expect(result).toEqual({ previousQuantity: 1, nextQuantity: 3 })
	const mutation = fetchStub.mock.calls.find(
		([request, init]) =>
			String(request).includes('/v1/subscription_items/si_stripe_paid') &&
			init?.method === 'POST',
	)
	expect(mutation?.[1]).toMatchObject({
		method: 'POST',
		body: 'quantity=3',
	})
})

test('syncOrgSeatQuantity no-ops for free orgs', async () => {
	const orgId = testStableUserIdFromEmail('free-org@example.com')
	await ensureOrgsTestSchema(env.APP_DB)
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
		 VALUES (?, ?, 'free', ?, ?)`,
	)
		.bind(orgId, 'free-org', now, now)
		.run()
	using fetchStub = stubStripeFetch(() =>
		jsonResponse({ error: 'unexpected' }, 500),
	)
	expect(
		await syncOrgSeatQuantity({
			db: env.APP_DB,
			env: {
				STRIPE_SECRET_KEY: 'sk_test',
				STRIPE_API_BASE_URL: 'https://stripe.mock',
			},
			orgId,
		}),
	).toBeNull()
	expect(fetchStub).not.toHaveBeenCalled()
})

test('syncOrgSeatQuantity updates Stripe when seat count changes', async () => {
	const orgId = testStableUserIdFromEmail('paid-org@example.com')
	await seedPaidOrg({
		orgId,
		stripeCustomerId: 'cus_seats',
		seatRoles: ['owner', 'member', 'member'],
	})
	using fetchStub = stubStripeFetch((url) => {
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse({
				data: [
					{
						id: 'sub_paid',
						status: 'active',
						cancel_at: null,
						items: {
							data: [
								{
									id: 'si_paid',
									quantity: 1,
									price: { id: 'price_pro' },
								},
							],
						},
					},
				],
			})
		}
		if (url.includes('/v1/subscription_items/si_paid')) {
			return jsonResponse({ id: 'si_paid', quantity: 3 })
		}
		return jsonResponse({ error: 'unexpected path' }, 500)
	})
	const result = await syncOrgSeatQuantity({
		db: env.APP_DB,
		env: {
			STRIPE_SECRET_KEY: 'sk_test',
			STRIPE_API_BASE_URL: 'https://stripe.mock',
			STRIPE_PRO_PRICE_ID: 'price_pro',
			STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		},
		orgId,
	})
	expect(result).toEqual({ previousQuantity: 1, nextQuantity: 3 })
	expect(
		fetchStub.mock.calls.some((call) =>
			String(call[0]).includes('subscription_items'),
		),
	).toBe(true)
})

test('syncOrgSeatQuantity ignores non-Kody subscriptions on the shared Stripe account', async () => {
	const orgId = testStableUserIdFromEmail('gratitext-neighbor@example.com')
	await seedPaidOrg({
		orgId,
		stripeCustomerId: 'cus_shared',
		seatRoles: ['owner', 'member'],
	})
	using fetchStub = stubStripeFetch((url) => {
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse({
				data: [
					{
						id: 'sub_gratitext',
						status: 'active',
						cancel_at: null,
						items: {
							data: [
								{
									id: 'si_gratitext',
									quantity: 1,
									price: { id: 'price_gratitext_premium_15' },
								},
							],
						},
					},
				],
			})
		}
		return jsonResponse({ error: 'must not mutate non-Kody' }, 500)
	})
	expect(
		await syncOrgSeatQuantity({
			db: env.APP_DB,
			env: {
				STRIPE_SECRET_KEY: 'sk_test',
				STRIPE_API_BASE_URL: 'https://stripe.mock',
				STRIPE_PRO_PRICE_ID: 'price_pro',
				STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
			},
			orgId,
		}),
	).toBeNull()
	expect(
		fetchStub.mock.calls.some((call) =>
			String(call[0]).includes('subscription_items'),
		),
	).toBe(false)
})

test('syncOrgSeatQuantity does not change retired Kody prices in P6', async () => {
	const orgId = testStableUserIdFromEmail('retired-standard@example.com')
	await seedPaidOrg({
		orgId,
		stripeCustomerId: 'cus_retired',
		seatRoles: ['owner', 'member', 'member'],
	})
	using fetchStub = stubStripeFetch((url) => {
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse({
				data: [
					{
						id: 'sub_retired',
						status: 'active',
						cancel_at: null,
						items: {
							data: [
								{
									id: 'si_retired',
									quantity: 1,
									price: { id: 'price_1U3sg6LAQpAnsYszGeL2nc8O' },
								},
							],
						},
					},
				],
			})
		}
		return jsonResponse({ error: 'must not mutate retired prices' }, 500)
	})
	expect(
		await syncOrgSeatQuantity({
			db: env.APP_DB,
			env: {
				STRIPE_SECRET_KEY: 'sk_test',
				STRIPE_API_BASE_URL: 'https://stripe.mock',
				STRIPE_PRO_PRICE_ID: 'price_pro',
				STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
			},
			orgId,
		}),
	).toBeNull()
	expect(
		fetchStub.mock.calls.some((call) =>
			String(call[0]).includes('subscription_items'),
		),
	).toBe(false)
})

test('syncOrgSeatQuantity updates only the Kody sub when a non-Kody sub shares the customer', async () => {
	const orgId = testStableUserIdFromEmail('mixed-customer@example.com')
	await seedPaidOrg({
		orgId,
		stripeCustomerId: 'cus_mixed',
		seatRoles: ['owner', 'member'],
	})
	using fetchStub = stubStripeFetch((url) => {
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse({
				data: [
					{
						id: 'sub_gratitext',
						status: 'active',
						cancel_at: null,
						items: {
							data: [
								{
									id: 'si_gratitext',
									quantity: 1,
									price: { id: 'price_gratitext_premium_15' },
								},
							],
						},
					},
					{
						id: 'sub_kody',
						status: 'active',
						cancel_at: null,
						items: {
							data: [
								{
									id: 'si_kody',
									quantity: 1,
									price: { id: 'price_pro' },
								},
							],
						},
					},
				],
			})
		}
		if (url.includes('/v1/subscription_items/si_kody')) {
			return jsonResponse({ id: 'si_kody', quantity: 2 })
		}
		return jsonResponse({ error: 'unexpected path' }, 500)
	})
	const result = await syncOrgSeatQuantity({
		db: env.APP_DB,
		env: {
			STRIPE_SECRET_KEY: 'sk_test',
			STRIPE_API_BASE_URL: 'https://stripe.mock',
			STRIPE_PRO_PRICE_ID: 'price_pro',
			STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		},
		orgId,
	})
	expect(result).toEqual({ previousQuantity: 1, nextQuantity: 2 })
	const mutatedUrls = fetchStub.mock.calls
		.map((call) => String(call[0]))
		.filter((url) => url.includes('subscription_items'))
	expect(mutatedUrls).toEqual([
		expect.stringContaining('/v1/subscription_items/si_kody'),
	])
})
