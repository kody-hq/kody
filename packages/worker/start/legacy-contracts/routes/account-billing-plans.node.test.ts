import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import type { AccountBillingLoaderData } from '#universal/loader-data.ts'
import {
	isRetiredPaidSubscription,
	renderAccountBillingPlans,
	resolveActiveStripePlan,
} from '../../pages/account-billing-plans.tsx'

function billing(
	overrides: Partial<AccountBillingLoaderData> = {},
): AccountBillingLoaderData {
	return {
		ok: true,
		configured: true,
		manualPlan: 'free',
		stripePlan: null,
		stripeInterval: null,
		effectivePlan: 'free',
		hasStripeCustomer: false,
		cancelAt: null,
		subscriptionStatus: null,
		purchasablePlans: ['pro'],
		creditsEligible: false,
		creditsHref: '/@ada/-/usage#credits',
		usageHref: '/@ada/-/usage',
		referralProgram: null,
		org: {
			slug: 'ada',
			displayName: null,
			personal: true,
			seats: 1,
		},
		...overrides,
	}
}

async function renderPlans(
	data: AccountBillingLoaderData,
	options: { checkoutError?: string } = {},
) {
	return renderToString(
		renderAccountBillingPlans({
			billing: data,
			activeStripePlan: resolveActiveStripePlan(data),
			paymentActionNeeded: false,
			checkoutPending: null,
			selectedIntervalByPlan: { pro: 'month' },
			promoCode: '',
			checkoutError: options.checkoutError ?? null,
			onIntervalChange: () => {},
			onPromoCodeChange: () => {},
			onStartCheckout: () => {},
		}),
	)
}

test('retired Standard and $49 Pro subscribers get a prorated switch to Pro', async () => {
	const retiredStandard = billing({
		stripePlan: 'standard',
		effectivePlan: 'standard',
		hasStripeCustomer: true,
	})
	const retiredPro = billing({
		stripePlan: 'pro',
		effectivePlan: 'pro',
		hasStripeCustomer: true,
	})
	for (const data of [retiredStandard, retiredPro]) {
		expect(isRetiredPaidSubscription(data)).toBe(true)
		const html = await renderPlans(data)
		expect(html).toContain('Switch to Pro (prorated)')
		expect(html).not.toContain('Current plan')
	}
})

test('purchasable Pro subscribers see their plan and the interval switch', async () => {
	const data = billing({
		stripePlan: 'pro',
		effectivePlan: 'pro',
		stripeInterval: 'month',
		hasStripeCustomer: true,
		creditsEligible: true,
	})
	expect(isRetiredPaidSubscription(data)).toBe(false)
	const html = await renderPlans(data)
	expect(html).toContain('Current plan')
	expect(html).toContain('Switch to annual (prorated)')
	expect(html).not.toContain('Switch to Pro')
})

test('an annual team subscription shows its annual seat total', async () => {
	const team = {
		slug: 'acme',
		displayName: 'Acme',
		personal: false,
		seats: 3,
	}
	const annual = await renderPlans(
		billing({
			stripePlan: 'pro',
			stripeInterval: 'year',
			effectivePlan: 'pro',
			hasStripeCustomer: true,
			creditsEligible: true,
			org: team,
		}),
	)
	expect(annual).toContain('3 seats · $360/year')
	expect(annual).not.toContain('3 seats · $36/month')
	expect(await renderPlans(billing({ org: team }))).toContain(
		'3 seats · $36/month',
	)
})
