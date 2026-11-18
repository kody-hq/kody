import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	applySecondAgentGiftInvoiceCredits,
	secondAgentGiftMetadataKey,
} from './second-agent-gift-invoice-credit.ts'

const now = new Date('2026-11-17T12:00:00Z')

type FakeSubscription = {
	customer: string
	status: string
	interval: 'month' | 'year'
	unitAmount: number
}

function fixture() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE orgs (id TEXT, plan TEXT DEFAULT 'free',
	 stripe_customer_id TEXT, second_agent_standard_gift_expires_at TEXT,
	 second_agent_gift_invoice_credit_requested_at TEXT,
	 second_agent_gift_invoice_credit_id TEXT,
	 updated_at TEXT, deleted_at TEXT, deleting_at TEXT);`)
	const subscriptions: Array<FakeSubscription> = []
	const balance: Array<{
		id: string
		customer: string
		amount: number
		currency: string
		metadata: Record<string, string>
	}> = []
	const idempotent = new Map<string, string>()
	const posts: Array<{ key: string | null; form: URLSearchParams }> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			const parsed = new URL(url)
			const headers = init.headers as Record<string, string>
			if (parsed.pathname === '/v1/subscriptions') {
				const customer = parsed.searchParams.get('customer')
				return Response.json({
					data: subscriptions
						.filter((sub) => sub.customer === customer)
						.map((sub, index) => ({
							id: `sub_${index}`,
							status: sub.status,
							cancel_at: null,
							currency: 'usd',
							metadata: { kody_org_id: `org-${customer}` },
							items: {
								data: [
									{
										quantity: 1,
										price: {
											id: 'price_pro',
											unit_amount: sub.unitAmount,
											recurring: { interval: sub.interval, interval_count: 1 },
										},
									},
								],
							},
						})),
				})
			}
			const match = parsed.pathname.match(
				/^\/v1\/customers\/([^/]+)\/balance_transactions$/,
			)
			if (match && init.method === 'GET') {
				return Response.json({
					data: balance.filter((entry) => entry.customer === match[1]),
					has_more: false,
				})
			}
			if (match && init.method === 'POST') {
				const form = new URLSearchParams(String(init.body))
				const key = headers['idempotency-key'] ?? null
				posts.push({ key, form })
				const replay = key ? idempotent.get(key) : undefined
				const existing = balance.find((entry) => entry.id === replay)
				if (existing) return Response.json(existing)
				const entry = {
					id: `cbtxn_${balance.length + 1}`,
					customer: match[1]!,
					amount: Number(form.get('amount')),
					currency: form.get('currency') ?? 'usd',
					metadata: Object.fromEntries(
						[...form]
							.filter(([name]) => name.startsWith('metadata['))
							.map(([name, value]) => [name.slice(9, -1), value]),
					),
				}
				balance.push(entry)
				if (key) idempotent.set(key, entry.id)
				return Response.json(entry)
			}
			return new Response('not found', { status: 404 })
		}),
	)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		STRIPE_SECRET_KEY: 'sk_test_second_agent_gift',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	}
	function queue(customer: string, plan = 'free') {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, plan, stripe_customer_id, second_agent_gift_invoice_credit_requested_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(`org-${customer}`, plan, customer, now.toISOString())
	}
	function org(customer: string) {
		return sqlite
			.prepare(
				`SELECT second_agent_standard_gift_expires_at AS expires,
				        second_agent_gift_invoice_credit_requested_at AS requested,
				        second_agent_gift_invoice_credit_id AS creditId
				 FROM orgs WHERE id = ?`,
			)
			.get(`org-${customer}`)
	}
	return { sqlite, env, subscriptions, balance, posts, queue, org }
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('paid Pro gets 14 days of its price as one Stripe invoice credit, once per account', async () => {
	const f = fixture()
	try {
		f.subscriptions.push(
			{
				customer: 'cus_month',
				status: 'active',
				interval: 'month',
				unitAmount: 1200,
			},
			{
				customer: 'cus_year',
				status: 'active',
				interval: 'year',
				unitAmount: 12000,
			},
		)
		f.queue('cus_month')
		f.queue('cus_year')
		expect(
			await applySecondAgentGiftInvoiceCredits({ env: f.env, now }),
		).toEqual({ credited: 2, fallback: 0, failed: 0 })
		expect(
			f.balance.map((entry) => [entry.customer, entry.amount, entry.metadata]),
		).toEqual([
			[
				'cus_month',
				-560,
				{
					[secondAgentGiftMetadataKey]: 'org-cus_month',
					kody_org_id: 'org-cus_month',
				},
			],
			[
				'cus_year',
				-460,
				{
					[secondAgentGiftMetadataKey]: 'org-cus_year',
					kody_org_id: 'org-cus_year',
				},
			],
		])
		expect(f.posts.map((post) => post.key)).toEqual([
			'kody-second-agent-gift-org-cus_month',
			'kody-second-agent-gift-org-cus_year',
		])
		expect(f.org('cus_month')).toEqual({
			expires: null,
			requested: now.toISOString(),
			creditId: 'cbtxn_1',
		})

		// Applied credits are not picked up again.
		expect(
			await applySecondAgentGiftInvoiceCredits({ env: f.env, now }),
		).toEqual({ credited: 0, fallback: 0, failed: 0 })

		// Stripe succeeded but D1 lost the id: reuse the existing credit.
		f.sqlite
			.prepare(
				`UPDATE orgs SET second_agent_gift_invoice_credit_id = NULL WHERE id = ?`,
			)
			.run('org-cus_month')
		expect(
			await applySecondAgentGiftInvoiceCredits({ env: f.env, now }),
		).toEqual({ credited: 1, fallback: 0, failed: 0 })
		expect(f.balance).toHaveLength(2)
		expect(f.posts).toHaveLength(2)
		expect(f.org('cus_month')).toMatchObject({ creditId: 'cbtxn_1' })
	} finally {
		f.sqlite.close()
	}
})

test('a subscription that ended before the credit applied falls back to the Free overlay', async () => {
	const f = fixture()
	try {
		f.subscriptions.push({
			customer: 'cus_gone',
			status: 'canceled',
			interval: 'month',
			unitAmount: 1200,
		})
		f.queue('cus_gone')
		f.queue('cus_manual', 'max')
		expect(
			await applySecondAgentGiftInvoiceCredits({ env: f.env, now }),
		).toEqual({ credited: 0, fallback: 2, failed: 0 })
		expect(f.org('cus_gone')).toEqual({
			expires: '2026-12-01T12:00:00.000Z',
			requested: null,
			creditId: null,
		})
		expect(f.org('cus_manual')).toEqual({
			expires: null,
			requested: null,
			creditId: null,
		})
		expect(f.posts).toEqual([])
	} finally {
		f.sqlite.close()
	}
})
