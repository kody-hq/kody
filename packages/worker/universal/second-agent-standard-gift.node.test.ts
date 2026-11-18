import { expect, test } from 'vitest'
import {
	describeSecondAgentStandardGift,
	isSecondAgentStandardGiftActive,
	resolveEffectivePlanWithSecondAgentGift,
	resolvePlanOverlay,
	resolveSecondAgentStandardGiftWrite,
	secondAgentGiftInvoiceCreditMinor,
} from './second-agent-standard-gift.ts'

const now = new Date('2026-09-07T12:00:00.000Z')
const inTwoWeeks = '2026-09-21T12:00:00.000Z'
const yesterday = '2026-09-06T12:00:00.000Z'
const granted = now.toISOString()

type PlanArgs = Parameters<typeof resolvePlanOverlay>

test('gift overlay raises free to the purchasable Pro once, never double-applies, and routes paid tiers to an invoice credit', () => {
	expect(
		[inTwoWeeks, yesterday, null].map((expiresAt) =>
			isSecondAgentStandardGiftActive(expiresAt, now),
		),
	).toEqual([true, false, false])

	// Retired Standard keeps its own plan (and table) under an overlay.
	const overlays: Array<[PlanArgs, ReturnType<typeof resolvePlanOverlay>]> = [
		[['free', null, inTwoWeeks, now], { plan: 'pro', isProOverlay: true }],
		[
			['free', 'standard', inTwoWeeks, now],
			{ plan: 'standard', isProOverlay: false },
		],
		[['free', 'pro', inTwoWeeks, now], { plan: 'pro', isProOverlay: false }],
	]
	expect(overlays.map(([args]) => [args, resolvePlanOverlay(...args)])).toEqual(
		overlays,
	)

	const effective: Array<[PlanArgs, string]> = [
		[['free', null, inTwoWeeks, now], 'pro'],
		[['free', null, yesterday, now], 'free'],
		[['free', 'standard', inTwoWeeks, now], 'standard'],
		[['free', 'pro', inTwoWeeks, now], 'pro'],
		[['max', null, inTwoWeeks, now], 'max'],
		[['pro', 'standard', inTwoWeeks, now], 'pro'],
	]
	expect(
		effective.map(([args]) => [
			args,
			resolveEffectivePlanWithSecondAgentGift(...args),
		]),
	).toEqual(effective)

	expect(
		resolveSecondAgentStandardGiftWrite({
			manualPlan: 'free',
			stripePlan: null,
			hasStripeCustomer: false,
			now,
		}),
	).toEqual({ kind: 'overlay', expiresAt: inTwoWeeks })

	// Paid Kody Stripe plans get 2 weeks as an invoice credit, even with a
	// manual grant on top. Manual grants without Stripe have nothing to extend.
	const writes = [
		[
			{ manualPlan: 'free', stripePlan: 'standard', hasStripeCustomer: true },
			'invoice_credit',
		],
		[
			{ manualPlan: 'free', stripePlan: 'pro', hasStripeCustomer: true },
			'invoice_credit',
		],
		[
			{ manualPlan: 'pro', stripePlan: 'pro', hasStripeCustomer: true },
			'invoice_credit',
		],
		[
			{ manualPlan: 'free', stripePlan: null, hasStripeCustomer: true },
			'overlay',
		],
		[
			{ manualPlan: 'standard', stripePlan: null, hasStripeCustomer: false },
			'included',
		],
		[
			{ manualPlan: 'max', stripePlan: null, hasStripeCustomer: true },
			'included',
		],
	] as const
	expect(
		writes.map(([plans]) => [
			plans,
			resolveSecondAgentStandardGiftWrite({ ...plans, now }).kind,
		]),
	).toEqual(writes)

	const descriptions = [
		[null, null, { received: false, active: false, status: 'none' }],
		[granted, inTwoWeeks, { received: true, active: true, status: 'active' }],
		[granted, yesterday, { received: true, active: false, status: 'expired' }],
		[granted, null, { received: true, active: false, status: 'already_paid' }],
	] as const
	expect(
		descriptions.map(([grantedAt, expiresAt]) =>
			describeSecondAgentStandardGift({ grantedAt, expiresAt, now }),
		),
	).toEqual(
		descriptions.map(([grantedAt, expiresAt, state]) => ({
			...state,
			expiresAt,
			grantedAt,
		})),
	)
})

test('paid-plan invoice credit is described and worth 14 days of the price', () => {
	expect(
		describeSecondAgentStandardGift({
			grantedAt: granted,
			expiresAt: null,
			invoiceCreditRequestedAt: granted,
			now,
		}),
	).toEqual({
		received: true,
		active: false,
		status: 'invoice_credit',
		expiresAt: null,
		grantedAt: granted,
	})
	const credits = [
		[
			{
				unitAmountMinor: 1200,
				quantity: 1,
				interval: 'month',
				intervalCount: 1,
			},
			560,
		],
		[
			{
				unitAmountMinor: 12000,
				quantity: 1,
				interval: 'year',
				intervalCount: 1,
			},
			460,
		],
		[
			{
				unitAmountMinor: 1200,
				quantity: 3,
				interval: 'month',
				intervalCount: 1,
			},
			1680,
		],
		[
			{
				unitAmountMinor: 1200,
				quantity: 1,
				interval: 'fortnight',
				intervalCount: 1,
			},
			0,
		],
	] as const
	expect(
		credits.map(([price]) => [price, secondAgentGiftInvoiceCreditMinor(price)]),
	).toEqual(credits)
})
