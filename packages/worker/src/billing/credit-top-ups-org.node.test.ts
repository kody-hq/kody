import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	isBillingConfigured: vi.fn(() => true),
	applyCreditPayment: vi.fn(async (_input: unknown) => ({
		applied: true,
		balanceMicroUsd: 25_000_000,
	})),
	createCreditTopUpCheckoutSession: vi.fn(
		async (_env: Env, _input: { metadata: Record<string, string> }) => ({
			id: 'cs_new',
			url: 'https://checkout.stripe.test/cs_new',
		}),
	),
	getCreditTopUpCheckoutSession: vi.fn(),
}))

vi.mock('#worker/billing/billing-config.ts', () => ({
	createBillingLinkReference: async (_env: Env, id: string) => `ref:${id}`,
	isBillingConfigured: () => mocks.isBillingConfigured(),
}))

vi.mock('#worker/billing/credit-wallet.ts', () => ({
	applyCreditPayment: mocks.applyCreditPayment,
}))

vi.mock('#worker/billing/stripe-client.ts', () => ({
	createCreditTopUpCheckoutSession: mocks.createCreditTopUpCheckoutSession,
	getCreditTopUpCheckoutSession: mocks.getCreditTopUpCheckoutSession,
}))

const { applyCreditTopUpFromCheckoutSession, startCreditTopUpCheckout } =
	await import('#worker/billing/credit-top-ups.ts')

const now = new Date('2026-01-01T00:00:00.000Z')

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			deleting_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE users (
			stable_user_id TEXT PRIMARY KEY,
			personal_org_id TEXT,
			deleted_at TEXT
		);
		INSERT INTO orgs (id, slug) VALUES
			('org-acme', 'acme'),
			('person-ada', 'ada'),
			('org-bea', 'bea'),
			('org-gone', 'gone');
		UPDATE orgs SET deleting_at = '2026-01-01T00:00:00.000Z' WHERE id = 'org-gone';
		INSERT INTO users (stable_user_id, personal_org_id) VALUES
			('person-ada', 'person-ada'),
			('person-bea', 'org-bea'),
			('person-gus', 'org-gone');
	`)
	return { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
}

/** A paid top-up session stamped the way checkout start stamped `id`. */
function paidSessionStampedWith(id: string, clientReferenceId = `ref:${id}`) {
	mocks.getCreditTopUpCheckoutSession.mockResolvedValue({
		id: 'cs_paid',
		mode: 'payment' as const,
		payment_status: 'paid' as const,
		currency: 'usd',
		amount_total: 2500,
		client_reference_id: clientReferenceId,
		metadata: {
			kody_credit_top_up: '1',
			kody_org_id: id,
			kody_stable_user_id: id,
		},
		payment_intent: { payment_method: null },
	})
}

async function startTopUpFor(orgId: string) {
	await startCreditTopUpCheckout({
		env: createEnv(),
		orgId,
		stripeCustomerId: 'cus_1',
		amountCents: 2500,
		creditsUrl: 'https://kody.codes/@x/-/usage#credits',
	})
	const [, input] = mocks.createCreditTopUpCheckoutSession.mock.calls.at(-1)!
	return input
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.isBillingConfigured.mockReturnValue(true)
})

test.each([
	['personal org id equals stable_user_id', 'person-ada'],
	['personal org id differs from stable_user_id', 'org-bea'],
	['team org', 'org-acme'],
])(
	'checkout start stamps the org id and completion credits it (%s)',
	async (_label, orgId) => {
		const started = await startTopUpFor(orgId)
		expect(started).toMatchObject({
			clientReferenceId: `ref:${orgId}`,
			metadata: { kody_org_id: orgId },
		})
		paidSessionStampedWith(orgId)

		for (const expectedOrgId of [orgId, undefined]) {
			const result = await applyCreditTopUpFromCheckoutSession({
				env: createEnv(),
				sessionId: 'cs_paid',
				expectedOrgId,
				now,
			})
			expect(result.orgId).toBe(orgId)
		}
		expect(mocks.applyCreditPayment).toHaveBeenCalledTimes(2)
		expect(mocks.applyCreditPayment).toHaveBeenCalledWith(
			expect.objectContaining({ userId: orgId, amountCents: 2500 }),
		)
	},
)

test('an in-flight session stamped with the legacy stable_user_id credits the personal org', async () => {
	paidSessionStampedWith('person-bea')

	for (const expectedOrgId of ['org-bea', undefined]) {
		const result = await applyCreditTopUpFromCheckoutSession({
			env: createEnv(),
			sessionId: 'cs_paid',
			expectedOrgId,
			now,
		})
		expect(result.orgId).toBe('org-bea')
	}
	expect(mocks.applyCreditPayment).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'org-bea' }),
	)
	expect(mocks.applyCreditPayment).not.toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'person-bea' }),
	)
})

test('completion rejects a session that credits a different org than the caller', async () => {
	paidSessionStampedWith('person-bea')
	await expect(
		applyCreditTopUpFromCheckoutSession({
			env: createEnv(),
			sessionId: 'cs_paid',
			expectedOrgId: 'org-acme',
			now,
		}),
	).rejects.toMatchObject({ code: 'client_reference_mismatch' })

	paidSessionStampedWith('org-acme', 'ref:org-bea')
	await expect(
		applyCreditTopUpFromCheckoutSession({
			env: createEnv(),
			sessionId: 'cs_paid',
			expectedOrgId: 'org-bea',
			now,
		}),
	).rejects.toMatchObject({ code: 'client_reference_mismatch' })
	expect(mocks.applyCreditPayment).not.toHaveBeenCalled()
})

test.each([
	['an unknown org id', 'org-missing'],
	['an org mid-delete', 'org-gone'],
	['a legacy stamp whose personal org is mid-delete', 'person-gus'],
])('completion rejects %s', async (_label, id) => {
	paidSessionStampedWith(id)
	await expect(
		applyCreditTopUpFromCheckoutSession({
			env: createEnv(),
			sessionId: 'cs_paid',
			now,
		}),
	).rejects.toMatchObject({ code: 'user_not_found' })
	expect(mocks.applyCreditPayment).not.toHaveBeenCalled()
})
