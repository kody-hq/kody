import { expect, test } from 'vitest'
import {
	createBillingLinkReference,
	getBillingPortalConfigurationId,
	getMatchingPriceIdsForPlan,
	getPriceIdForPlan,
	getPurchasablePlans,
	isCreditsEligiblePriceId,
	isKodySubscription,
	isPurchasableProSubscription,
	parseBillingInterval,
	retiredProPriceIds,
	retiredStandardPriceIds,
	resolveSubscriptionPlan,
	selectKodyPlanRetainingSubscriptions,
	selectPlanRetainingSubscriptions,
	subscriptionHasPrice,
} from './billing-config.ts'
import type { StripeSubscription } from './stripe-client.ts'

function subscription(input: {
	id?: string
	status: string
	cancel_at?: number | null
	priceIds?: Array<string>
	metadata?: Record<string, string>
}): StripeSubscription {
	return {
		id: input.id ?? 'sub_test',
		status: input.status,
		cancel_at: input.cancel_at ?? null,
		current_period_end: undefined,
		metadata: input.metadata,
		items: {
			data: (input.priceIds ?? []).map((id) => ({
				id: undefined,
				quantity: undefined,
				price: { id },
				current_period_end: undefined,
			})),
		},
	}
}

test('createBillingLinkReference is stable per user and not the raw stable id', async () => {
	const envStub = { COOKIE_SECRET: 'x'.repeat(32) }
	const first = await createBillingLinkReference(envStub, 'stable-user-1')
	const second = await createBillingLinkReference(envStub, 'stable-user-1')
	const other = await createBillingLinkReference(envStub, 'stable-user-2')
	const otherSecret = await createBillingLinkReference(
		{ COOKIE_SECRET: 'y'.repeat(32) },
		'stable-user-1',
	)
	expect(first).toBe(second)
	expect(first).not.toBe('stable-user-1')
	expect(first).not.toBe(other)
	expect(first).not.toBe(otherSecret)
	expect(first).toMatch(/^[0-9a-f]{64}$/)
})

const env = {
	STRIPE_PRO_PRICE_ID: 'price_pro',
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
}
const retiredStandardMonthly = 'price_1U3sg6LAQpAnsYszGeL2nc8O'
const retiredStandardYearly = 'price_1U3sg6LAQpAnsYszqq9abwIY'
const retiredProMonthly = 'price_1UChg1LAQpAnsYszAYn6eGgt'
const retiredProYearly = 'price_1UChg2LAQpAnsYszKAFCR778'

type Subscriptions = Array<StripeSubscription>
type ResolvedPlan = ReturnType<typeof resolveSubscriptionPlan>

const active = (...priceIds: Array<string>) =>
	subscription({ status: 'active', priceIds })
const resolve = (subscriptions: Subscriptions) =>
	resolveSubscriptionPlan(subscriptions, env)
const noPlan = {
	stripePlan: null,
	creditsEligible: false,
	stripeInterval: null,
	stripePriceId: null,
	cancelAt: null,
}

function planTable(cases: Array<[Subscriptions, Partial<ResolvedPlan>]>) {
	return {
		actual: cases.map(([subscriptions]) => resolve(subscriptions)),
		expected: cases.map(([, plan]) => plan),
	}
}

test('resolveSubscriptionPlan maps active price and metadata plans with soonest cancel_at', () => {
	const sooner = 1_700_000_000
	const exact = planTable([
		[
			[
				subscription({ status: 'canceled', priceIds: ['price_pro'] }),
				subscription({ status: 'incomplete', priceIds: ['price_pro'] }),
			],
			{ ...noPlan, subscriptionStatus: 'incomplete' },
		],
		[
			[subscription({ status: 'trialing', priceIds: ['price_pro'] })],
			{
				stripePlan: 'pro',
				creditsEligible: true,
				stripeInterval: 'month',
				stripePriceId: 'price_pro',
				cancelAt: null,
				subscriptionStatus: 'trialing',
			},
		],
		[
			[
				subscription({
					status: 'active',
					priceIds: ['price_other'],
					metadata: { kody_plan: 'pro' },
				}),
			],
			{ ...noPlan, stripePlan: 'pro', subscriptionStatus: 'active' },
		],
	])
	expect(exact.actual).toEqual(exact.expected)

	const partial = planTable([
		// Retired plan names in metadata do not override known price ids.
		[
			[
				subscription({
					status: 'active',
					priceIds: [retiredStandardMonthly],
					metadata: { kody_plan: 'partner' },
				}),
			],
			{ stripePlan: 'standard', creditsEligible: false },
		],
		[[active('price_unknown')], { stripePlan: null, creditsEligible: false }],
		[
			[
				subscription({
					status: 'active',
					priceIds: ['price_pro'],
					cancel_at: 1_800_000_000,
				}),
				subscription({
					status: 'trialing',
					priceIds: ['price_pro'],
					cancel_at: sooner,
				}),
				subscription({
					status: 'canceled',
					priceIds: ['price_pro'],
					cancel_at: 1,
				}),
			],
			{
				stripePlan: 'pro',
				creditsEligible: true,
				cancelAt: new Date(sooner * 1000).toISOString(),
				subscriptionStatus: 'active',
			},
		],
		[
			[subscription({ status: 'past_due', priceIds: ['price_pro'] })],
			{ stripePlan: 'pro', subscriptionStatus: 'past_due' },
		],
		[
			[subscription({ status: 'unpaid', priceIds: ['price_pro'] })],
			{ stripePlan: null, creditsEligible: false },
		],
		[
			[active('price_pro_yearly')],
			{
				stripePlan: 'pro',
				creditsEligible: true,
				stripeInterval: 'year',
				stripePriceId: 'price_pro_yearly',
			},
		],
	])
	expect(partial.actual).toMatchObject(partial.expected)

	expect(getPurchasablePlans(env)).toEqual(['pro'])
	expect(getPurchasablePlans({})).toEqual([])
	expect(
		[undefined, null, '', 'weekly'].map((value) => parseBillingInterval(value)),
	).toEqual(['month', 'month', 'month', null])
	expect([
		getPriceIdForPlan(env, 'pro'),
		getPriceIdForPlan(env, 'pro', 'year'),
		getPriceIdForPlan({}, 'pro', 'year'),
	]).toEqual(['price_pro', 'price_pro_yearly', null])
})

test('credit wallet eligibility keys off the purchasable Pro price, not plan or list price', () => {
	const eligibility: Array<
		[Parameters<typeof isCreditsEligiblePriceId>, boolean]
	> = [
		[[env, 'price_pro'], true],
		[[env, ' price_pro_yearly '], true],
		[[env, retiredStandardMonthly], false],
		[[env, retiredProMonthly], false],
		[[env, null], false],
		[[{}, 'price_pro'], false],
	]
	expect(
		eligibility.map(([args]) => isCreditsEligiblePriceId(...args)),
	).toEqual(eligibility.map(([, want]) => want))

	// Retired Standard at the same $12 list price: plan kept, no wallet.
	expect(resolve([active(retiredStandardMonthly)])).toEqual({
		...noPlan,
		stripePlan: 'standard',
		stripePriceId: retiredStandardMonthly,
		subscriptionStatus: 'active',
	})
	const partial = planTable([
		[
			[active(retiredStandardYearly)],
			{ stripePlan: 'standard', creditsEligible: false },
		],
		// Retired $49 / $480 Pro: plan kept, no wallet.
		...[retiredProMonthly, retiredProYearly].map(
			(priceId): [Subscriptions, Partial<ResolvedPlan>] => [
				[active(priceId)],
				{
					stripePlan: 'pro',
					creditsEligible: false,
					stripeInterval: null,
					stripePriceId: priceId,
				},
			],
		),
		// A retired Pro beside the purchasable Pro surfaces the wallet.
		[
			[active(retiredProMonthly), active('price_pro')],
			{ stripePlan: 'pro', creditsEligible: true, stripePriceId: 'price_pro' },
		],
	])
	expect(partial.actual).toMatchObject(partial.expected)
})

test('resolveSubscriptionPlan reports the interval of the subscription that granted the plan', () => {
	const yearlyPro = {
		stripePlan: 'pro',
		stripeInterval: 'year',
		stripePriceId: 'price_pro_yearly',
	} as const
	const partial = planTable([
		[[active(retiredStandardMonthly), active('price_pro_yearly')], yearlyPro],
		[[active('price_pro_yearly'), active(retiredStandardMonthly)], yearlyPro],
	])
	expect(partial.actual).toMatchObject(partial.expected)
})

test('selectPlanRetainingSubscriptions and subscriptionHasPrice drive the checkout guard', () => {
	const activeSub = subscription({
		id: 'sub_active',
		status: 'active',
		priceIds: [retiredStandardMonthly],
	})
	const trialing = subscription({ id: 'sub_trial', status: 'trialing' })
	expect(
		selectPlanRetainingSubscriptions([
			subscription({ id: 'sub_canceled', status: 'canceled' }),
			activeSub,
			subscription({ id: 'sub_unpaid', status: 'unpaid' }),
			subscription({
				id: 'sub_past_due',
				status: 'past_due',
				priceIds: ['price_pro'],
			}),
			subscription({ id: 'sub_incomplete', status: 'incomplete' }),
			trialing,
		]).map((entry) => entry.id),
	).toEqual(['sub_active', 'sub_past_due', 'sub_trial'])

	expect([
		subscriptionHasPrice(activeSub, retiredStandardMonthly),
		subscriptionHasPrice(activeSub, 'price_pro'),
		subscriptionHasPrice(trialing, retiredStandardMonthly),
	]).toEqual([true, false, false])

	expect(
		[undefined, '  ', ' bpc_kody '].map((id) =>
			getBillingPortalConfigurationId(
				id === undefined ? {} : { STRIPE_BILLING_PORTAL_CONFIGURATION_ID: id },
			),
		),
	).toEqual([null, null, 'bpc_kody'])
})

test('isKodySubscription requires a Kody price or Kody metadata', () => {
	const gratitext = subscription({
		id: 'sub_gratitext',
		status: 'active',
		priceIds: ['price_gratitext_premium_15'],
	})
	const purchasablePro = subscription({
		id: 'sub_pro',
		status: 'active',
		priceIds: ['price_pro'],
	})
	const retiredStandard = subscription({
		id: 'sub_retired_standard',
		status: 'active',
		priceIds: [retiredStandardMonthly],
	})
	const metadataOnly = subscription({
		id: 'sub_meta',
		status: 'active',
		priceIds: ['price_rotated_unknown'],
		metadata: { kody_plan: 'pro' },
	})
	expect(isKodySubscription(env, gratitext)).toBe(false)
	expect(isKodySubscription(env, purchasablePro)).toBe(true)
	expect(isKodySubscription(env, retiredStandard)).toBe(true)
	expect(isKodySubscription(env, metadataOnly)).toBe(true)
	expect(isPurchasableProSubscription(env, purchasablePro)).toBe(true)
	expect(isPurchasableProSubscription(env, retiredStandard)).toBe(false)
	expect(
		selectKodyPlanRetainingSubscriptions(env, [
			gratitext,
			purchasablePro,
			retiredStandard,
			subscription({
				id: 'sub_canceled_pro',
				status: 'canceled',
				priceIds: ['price_pro'],
			}),
		]).map((entry) => entry.id),
	).toEqual(['sub_pro', 'sub_retired_standard'])
	// Unmapped products never grant a Kody plan, even when plan-retaining.
	expect(resolveSubscriptionPlan([gratitext], env)).toMatchObject({
		stripePlan: null,
		stripePriceId: null,
		creditsEligible: false,
	})
	// A Kody sub beside an unmapped product still resolves the Kody plan only.
	expect(
		resolveSubscriptionPlan([gratitext, retiredStandard], env),
	).toMatchObject({
		stripePlan: 'standard',
		stripePriceId: retiredStandardMonthly,
		creditsEligible: false,
	})
})

test('retired Standard and Pro price ids keep resolving their plans', () => {
	expect(getMatchingPriceIdsForPlan(env, 'standard').sort()).toEqual(
		[...retiredStandardPriceIds].sort(),
	)
	expect(getMatchingPriceIdsForPlan(env, 'pro').sort()).toEqual(
		['price_pro', 'price_pro_yearly', ...retiredProPriceIds].sort(),
	)
	const partial = planTable([
		...[
			'price_1U3sg6LAQpAnsYszlVpEIFGx',
			'price_1U3sg7LAQpAnsYszpozAEFUi',
			'price_1U1AISLAQpAnsYszIQvRJNhl',
		].map((priceId): [Subscriptions, Partial<ResolvedPlan>] => [
			[active(priceId)],
			{ stripePlan: 'pro', creditsEligible: false },
		]),
		[
			[active('price_1Tv3W2LAQpAnsYszSr4PGBkE')],
			{ stripePlan: 'standard', creditsEligible: false },
		],
	])
	expect(partial.actual).toMatchObject(partial.expected)
})
