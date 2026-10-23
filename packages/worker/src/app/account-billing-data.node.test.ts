import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	BillingPlanUnavailableError,
	loadAccountBillingData,
} from '#app/account-billing-data.ts'

const refreshStripePlanForUser = vi.hoisted(() =>
	vi.fn(async () => ({
		stripePlan: 'pro' as const,
		stripeInterval: 'month' as 'month' | 'year' | null,
		stripePriceId: 'price_pro' as string | null,
		cancelAt: null as string | null,
		subscriptionStatus: 'active' as string | null,
	})),
)
const refreshStripePlanForOrg = vi.hoisted(() =>
	vi.fn(async () => ({
		stripePlan: 'pro' as const,
		creditsEligible: true,
		stripeInterval: 'month' as 'month' | 'year' | null,
		stripePriceId: 'price_pro' as string | null,
		cancelAt: null as string | null,
		subscriptionStatus: 'active' as string | null,
	})),
)
const scheduleStripePlanRefreshBackstop = vi.hoisted(() =>
	vi.fn(async () => true),
)

vi.mock('#worker/billing/subscription-sync.ts', () => ({
	refreshStripePlanForOrg,
	refreshStripePlanForUser,
}))
vi.mock('#worker/billing/stripe-plan-refresh-client.ts', () => ({
	scheduleStripePlanRefreshBackstop,
}))

const personalOrg = {
	id: ownerIdFromStored('stable-user-id'),
	slug: 'billing-user',
	displayName: null,
	personal: true,
}

const teamOrg = {
	id: ownerIdFromStored('org-acme'),
	slug: 'acme',
	displayName: 'Acme',
	personal: false,
}

function createBillingEnv(input: {
	stripePlan: string | null
	stripeCustomerId: string | null
	orgStripeCustomerId?: string | null
}) {
	const userRow = {
		plan: 'free',
		username: 'billing-user',
		stable_user_id: 'stable-user-id',
		stripe_plan: input.stripePlan,
		stripe_customer_id: input.stripeCustomerId,
		stripe_plan_refreshed_at: null,
		second_agent_standard_gift_expires_at: null,
		referral_standard_credit_expires_at: null,
	}
	const orgRow = {
		plan: 'free',
		stripe_plan: null,
		stripe_credits_eligible: 0,
		stripe_customer_id: input.orgStripeCustomerId ?? null,
	}
	const db = {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			const statement = {
				bind: () => statement,
				first: async () =>
					normalized.includes('from users') && normalized.includes('join orgs')
						? userRow
						: normalized.includes('from orgs') &&
							  normalized.includes('where id')
							? orgRow
							: null,
				all: async () => ({ results: [] }),
				run: async () => ({ success: true }),
			}
			return statement
		},
	}
	return {
		APP_DB: db,
		STRIPE_SECRET_KEY: 'sk_test',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	} as unknown as Env
}

test('loadAccountBillingData refreshes Stripe status and degrades when refresh is unavailable', async () => {
	refreshStripePlanForUser.mockResolvedValueOnce({
		stripePlan: 'pro',
		stripeInterval: 'year',
		stripePriceId: 'price_pro_yearly',
		cancelAt: '2026-08-01T00:00:00.000Z',
		subscriptionStatus: 'past_due',
	})
	const env = createBillingEnv({
		stripePlan: 'pro',
		stripeCustomerId: 'cus_test',
	})
	const now = new Date('2026-07-25T12:00:00.000Z')

	const data = await loadAccountBillingData({
		env,
		userId: 9,
		org: personalOrg,
		seats: 1,
		noticeCode: 'updated',
		now,
	})
	expect(data).toMatchObject({
		ok: true,
		configured: true,
		hasStripeCustomer: true,
		stripePlan: 'pro',
		stripeInterval: 'year',
		notice: expect.stringMatching(/\S/),
		effectivePlan: 'pro',
		subscriptionStatus: 'past_due',
		cancelAt: '2026-08-01T00:00:00.000Z',
		usageHref: '/@billing-user/-/usage',
		purchasablePlans: ['pro'],
		creditsHref: '/@billing-user/-/usage#credits',
		referralProgram: expect.objectContaining({
			sharePath: '/signup?ref=billing-user',
			rewardedCount: 0,
			pendingCount: 0,
			creditExpiresAt: null,
			creditActive: false,
			referrals: [],
		}),
	})
	expect(data.error).toBeUndefined()
	expect(refreshStripePlanForUser).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 9, customerId: 'cus_test' }),
	)
	expect(scheduleStripePlanRefreshBackstop).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('stable-user-id'),
		now,
	})

	consoleError.mockImplementation(() => {})
	refreshStripePlanForUser.mockRejectedValueOnce(new Error('stripe down'))
	const failed = await loadAccountBillingData({
		env,
		userId: 3,
		org: personalOrg,
		seats: 1,
	})
	expect(failed).toMatchObject({
		stripePlan: 'pro',
		stripeInterval: null,
		subscriptionStatus: null,
		cancelAt: null,
	})
	expect(failed.notice).toBeUndefined()
	expect(consoleError).toHaveBeenCalledWith(
		'account_billing_refresh_failed',
		expect.objectContaining({ userId: 3, error: 'stripe down' }),
	)

	refreshStripePlanForUser.mockClear()
	expect(
		await loadAccountBillingData({
			env: createBillingEnv({ stripePlan: null, stripeCustomerId: null }),
			userId: 4,
			org: personalOrg,
			seats: 1,
		}),
	).toMatchObject({
		hasStripeCustomer: false,
		subscriptionStatus: null,
		configured: true,
		purchasablePlans: ['pro'],
	})
	expect(refreshStripePlanForUser).not.toHaveBeenCalled()
	expect(scheduleStripePlanRefreshBackstop).toHaveBeenCalledTimes(2)
})

test("a team organization reads and refreshes its own Stripe customer, not the viewer's", async () => {
	refreshStripePlanForUser.mockClear()
	refreshStripePlanForOrg.mockClear()
	const env = createBillingEnv({
		stripePlan: 'pro',
		stripeCustomerId: 'cus_person',
		orgStripeCustomerId: 'cus_acme',
	})
	const data = await loadAccountBillingData({
		env,
		userId: 9,
		org: teamOrg,
		seats: 4,
	})
	expect(data).toMatchObject({
		hasStripeCustomer: true,
		stripePlan: 'pro',
		effectivePlan: 'pro',
		creditsEligible: true,
		creditsHref: '/@acme/-/usage#credits',
		usageHref: '/@acme/-/usage',
		referralProgram: null,
		org: {
			slug: 'acme',
			displayName: 'Acme',
			personal: false,
			seats: 4,
		},
	})
	expect(refreshStripePlanForOrg).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: ownerIdFromStored('org-acme'),
			customerId: 'cus_acme',
		}),
	)
	expect(refreshStripePlanForUser).not.toHaveBeenCalled()
})

test('loadAccountBillingData fails closed when the personal plan row is missing', async () => {
	const env = {
		APP_DB: {
			prepare() {
				const statement = {
					bind: () => statement,
					first: async () => null,
					all: async () => ({ results: [] }),
					run: async () => ({ success: true }),
				}
				return statement
			},
		},
		STRIPE_SECRET_KEY: 'sk_test',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	} as unknown as Env

	await expect(
		loadAccountBillingData({
			env,
			userId: 800,
			org: personalOrg,
			seats: 1,
		}),
	).rejects.toBeInstanceOf(BillingPlanUnavailableError)
})
