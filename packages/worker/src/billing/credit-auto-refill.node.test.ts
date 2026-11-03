import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { runCreditAutoRefill } from './credit-auto-refill.ts'
import { updateCreditWalletSettings } from './credit-wallet.ts'

const now = new Date('2026-09-27T12:00:00.000Z')
const userId = 'user-refill-test'
const customerId = 'cus_refill_test'
const paymentMethodId = 'pm_refill_test'
const amountCents = 1_000
const refillIdempotencyKey =
	'kody-credit-auto-refill:user-refill-test:2026-09:1'
const refillMetadataKey = 'kody_credit_auto_refill'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function idempotencyMismatchResponse() {
	return jsonResponse(
		{
			error: {
				message:
					'Keys for idempotent requests can only be used with the same parameters they were first used with.',
				type: 'idempotency_error',
			},
		},
		400,
	)
}

function formOf(init: unknown) {
	return Object.fromEntries(
		new URLSearchParams((init as RequestInit).body as string),
	)
}

function createTestEnv(db: D1Database) {
	return {
		APP_DB: db,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
	} as unknown as Env
}

async function seedWallet(db: D1Database) {
	await updateCreditWalletSettings({
		db,
		userId,
		autoRefill: {
			enabled: true,
			thresholdCents: 500,
			amountCents,
			monthlyCapCents: 10_000,
		},
		notify: { autoRefilled: false, monthlyCap: false, lowBalance: false },
		now,
	})
	await db
		.prepare(
			`UPDATE credit_wallets
			 SET balance_micro_usd = 0,
			     auto_refill_payment_method_id = ?
			 WHERE user_id = ?`,
		)
		.bind(paymentMethodId, userId)
		.run()
}

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

test('runCreditAutoRefill heals an idempotency mismatch from the PaymentIntent list', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	// The key is bound to an intent created with different metadata (e.g. the
	// pre-deploy dual-write shape); Stripe rejects the replay, the list heals it.
	const boundIntent = {
		id: 'pi_bound_to_key',
		status: 'succeeded',
		amount: amountCents,
		currency: 'usd',
		metadata: { [refillMetadataKey]: '1', kody_org_id: userId },
	}
	let listCount = 0
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			listCount += 1
			return jsonResponse({ data: listCount === 1 ? [] : [boundIntent] })
		}
		if (method === 'POST' && url.includes('/v1/payment_intents')) {
			const key = (init?.headers as Record<string, string>)?.['idempotency-key']
			expect(key).toBe(refillIdempotencyKey)
			return idempotencyMismatchResponse()
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		const ledger = await db
			.prepare(
				`SELECT stripe_reference, kind FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.bind(userId)
			.first<{ stripe_reference: string; kind: string }>()
		expect(ledger).toEqual({
			stripe_reference: 'pi_bound_to_key',
			kind: 'auto_refill',
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('runCreditAutoRefill applies an unledgered succeeded PaymentIntent from listing', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const orphanIntent = {
		id: 'pi_orphan_succeeded',
		status: 'succeeded',
		amount: amountCents,
		currency: 'usd',
		metadata: {
			[refillMetadataKey]: '1',
			kody_org_id: userId,
		},
	}
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse({ data: [orphanIntent] })
		}
		if (method === 'POST') {
			return idempotencyMismatchResponse()
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		const ledger = await db
			.prepare(
				`SELECT stripe_reference FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.bind(userId)
			.first<{ stripe_reference: string }>()
		expect(ledger?.stripe_reference).toBe('pi_orphan_succeeded')
		expect(
			fetchMock.mock.calls.some(
				([requestUrl, requestInit]) =>
					(requestInit?.method ?? 'GET') === 'POST' &&
					String(requestUrl).includes('/v1/payment_intents'),
			),
		).toBe(false)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('runCreditAutoRefill heals an orphan whose amount differs from current settings', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const orphanIntent = {
		id: 'pi_orphan_old_amount',
		status: 'succeeded',
		amount: 500,
		currency: 'usd',
		metadata: {
			[refillMetadataKey]: '1',
			kody_org_id: userId,
		},
	}
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse({ data: [orphanIntent], has_more: false })
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		const ledger = await db
			.prepare(
				`SELECT stripe_reference, amount_micro_usd FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.bind(userId)
			.first<{ stripe_reference: string; amount_micro_usd: number }>()
		expect(ledger).toEqual({
			stripe_reference: 'pi_orphan_old_amount',
			amount_micro_usd: 5_000_000,
		})
	} finally {
		vi.unstubAllGlobals()
	}
})

test('runCreditAutoRefill still creates when PaymentIntent listing fails', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse(
				{
					error: {
						message: 'Service unavailable',
						type: 'api_error',
					},
				},
				503,
			)
		}
		if (method === 'POST' && url.includes('/v1/payment_intents')) {
			return jsonResponse({
				id: 'pi_after_list_fail',
				status: 'succeeded',
				amount: amountCents,
				currency: 'usd',
			})
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		expect(fetchMock).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('runCreditAutoRefill lists then creates with org-id metadata when no orphan exists', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse({ data: [] })
		}
		if (method === 'POST' && url.includes('/v1/payment_intents')) {
			const key = (init?.headers as Record<string, string>)?.['idempotency-key']
			expect(key).toBe(refillIdempotencyKey)
			const form = formOf(init)
			expect(form).toMatchObject({
				[`metadata[${refillMetadataKey}]`]: '1',
				[`metadata[kody_org_id]`]: userId,
			})
			expect(form['metadata[kody_stable_user_id]']).toBeUndefined()
			return jsonResponse({
				id: 'pi_new_org_metadata',
				status: 'succeeded',
				amount: amountCents,
				currency: 'usd',
			})
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		expect(fetchMock).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}
})
