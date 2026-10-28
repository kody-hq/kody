import { expect, test } from 'vitest'
import {
	legacyPlanLimits,
	planLimits,
	proCreditsPlanLimits,
	resolvePlanLimits,
} from '#universal/plans.ts'
import { resolveUserPlanFromRow } from './service.ts'

const freeBase = {
	plan: 'free',
	stripe_plan: null,
	entitlement_ladder: 'public',
	stripe_credits_eligible: 0,
	second_agent_standard_gift_expires_at: null,
	referral_standard_credit_expires_at: null,
} as const

test('gift/referral Pro overlay is not credits-eligible and keeps retired Pro ceilings', () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const gift = resolveUserPlanFromRow(
		{
			...freeBase,
			second_agent_standard_gift_expires_at: '2026-08-25T00:00:00.000Z',
		},
		now,
	)
	expect(gift).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditsEligible: false,
	})
	expect(resolvePlanLimits(gift.plan, gift.ladder, 'none')).toEqual(
		planLimits.pro,
	)
	expect(resolvePlanLimits(gift.plan, gift.ladder, 'none')).not.toEqual(
		proCreditsPlanLimits,
	)

	const referral = resolveUserPlanFromRow(
		{
			...freeBase,
			referral_standard_credit_expires_at: '2026-08-25T00:00:00.000Z',
		},
		now,
	)
	expect(referral.creditsEligible).toBe(false)
	expect(
		resolvePlanLimits(referral.plan, referral.ladder, 'none')
			.maxUniqueWorkerDaysPerMonth,
	).toBe(2_000)
})

test('purchasable Stripe Pro stays credits-eligible with Max stock and Standard rates', () => {
	const paying = resolveUserPlanFromRow({
		...freeBase,
		stripe_plan: 'pro',
		stripe_credits_eligible: 1,
	})
	expect(paying).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditsEligible: true,
	})
	const emptyLimits = resolvePlanLimits(paying.plan, paying.ladder, 'empty')
	expect(emptyLimits.maxSavedPackages).toBe(10_000)
	expect(emptyLimits.maxConcurrentWorkflows).toBe(200)
	expect(emptyLimits.maxUniqueWorkerDaysPerMonth).toBe(350)
	expect(emptyLimits.maxExecuteUniqueWorkersPerDay).toBe(500)
	expect(emptyLimits.maxExecuteUniqueWorkersPerWeek).toBe(1_200)
})

test('retired Stripe Pro and manual Pro stay on planLimits.pro without a wallet', () => {
	const retired = resolveUserPlanFromRow({
		...freeBase,
		stripe_plan: 'pro',
		stripe_credits_eligible: 0,
	})
	expect(retired).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditsEligible: false,
	})
	expect(resolvePlanLimits(retired.plan, retired.ladder, 'none')).toEqual(
		planLimits.pro,
	)

	const manual = resolveUserPlanFromRow({
		...freeBase,
		plan: 'pro',
	})
	expect(manual).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditsEligible: false,
	})
	expect(resolvePlanLimits(manual.plan, manual.ladder, 'none')).toEqual(
		planLimits.pro,
	)

	const legacy = resolveUserPlanFromRow({
		...freeBase,
		stripe_plan: 'pro',
		entitlement_ladder: 'legacy',
		stripe_credits_eligible: 0,
	})
	expect(legacy.creditsEligible).toBe(false)
	expect(resolvePlanLimits(legacy.plan, legacy.ladder, 'none')).toEqual(
		legacyPlanLimits.pro,
	)
})
