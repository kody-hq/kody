import { expect, test } from 'vitest'
import {
	presentIncludedCompute,
	presentIncludedComputeMeter,
	resolveCreditsAlarm,
} from './usage-presentation.ts'

test('Free compute past the include is never charged', () => {
	expect(
		presentIncludedComputeMeter({
			resource: 'unique_worker_days',
			current: 517,
			include: 50,
			plan: 'free',
			creditWallet: 'none',
		}),
	).toMatchObject({ informational: true, onCreditsMicroUsd: 0 })
})

test('funded Pro charges only usage past the include', () => {
	const meters = presentIncludedCompute({
		plan: 'pro',
		creditWallet: 'funded',
		meters: [
			{ resource: 'unique_worker_days', current: 43_768, include: 350 },
			{
				resource: 'durable_object_rows_read',
				current: 1_000_000_000,
				include: 5_000_000_000,
			},
		],
	})
	expect(meters[0]).toMatchObject({
		pastInclude: true,
		onCreditsMicroUsd: 173_672_000,
	})
	expect(meters[1]).toMatchObject({
		pastInclude: false,
		onCreditsMicroUsd: 0,
	})
})

test('an empty Pro wallet does not debit usage past the include', () => {
	expect(
		presentIncludedComputeMeter({
			resource: 'unique_worker_days',
			current: 400,
			include: 350,
			plan: 'pro',
			creditWallet: 'empty',
		}),
	).toMatchObject({ pastInclude: true, onCreditsMicroUsd: 0 })
})

test('credits alarm fires only when the wallet or access is at risk', () => {
	const past = [{ current: 400, include: 350 }]
	const within = [{ current: 100, include: 350 }]
	const autoRefillOff = {
		enabled: false,
		thresholdCents: null,
		amountCents: null,
		monthlyCapCents: null,
		refilledThisMonthCents: 0,
	}
	const alarm = (
		input: Partial<Parameters<typeof resolveCreditsAlarm>[0]> &
			Pick<
				Parameters<typeof resolveCreditsAlarm>[0],
				'creditWallet' | 'meters'
			>,
	) =>
		resolveCreditsAlarm({
			balanceMicroUsd: 0,
			canBuyCredits: true,
			autoRefill: autoRefillOff,
			...input,
		})

	expect(
		alarm({
			creditWallet: 'funded',
			meters: past,
			balanceMicroUsd: 40_000_000,
		}),
	).toBeNull()
	expect(
		alarm({
			creditWallet: 'none',
			meters: past,
			canBuyCredits: false,
			autoRefill: null,
		}),
	).toBeNull()
	expect(alarm({ creditWallet: 'empty', meters: within })).toBeNull()
	expect(alarm({ creditWallet: 'empty', meters: past })).toMatchObject({
		kind: 'include_used_no_credits',
	})
	expect(
		alarm({ creditWallet: 'empty', meters: [{ current: 300, include: 350 }] }),
	).toMatchObject({ kind: 'include_nearly_used_no_credits' })
	expect(
		alarm({ creditWallet: 'funded', meters: past, balanceMicroUsd: 3_000_000 }),
	).toMatchObject({ kind: 'credits_low' })
	expect(
		alarm({
			creditWallet: 'funded',
			meters: within,
			balanceMicroUsd: 3_000_000,
		}),
	).toBeNull()
	expect(
		alarm({
			creditWallet: 'funded',
			meters: within,
			balanceMicroUsd: 3_000_000,
			autoRefill: {
				enabled: true,
				thresholdCents: 500,
				amountCents: 2_500,
				monthlyCapCents: 5_000,
				refilledThisMonthCents: 5_000,
			},
		}),
	).toMatchObject({ kind: 'auto_refill_capped' })
	expect(
		alarm({
			creditWallet: 'funded',
			meters: past,
			balanceMicroUsd: 3_000_000,
			autoRefill: {
				enabled: true,
				thresholdCents: 500,
				amountCents: 2_500,
				monthlyCapCents: 10_000,
				refilledThisMonthCents: 2_500,
			},
		}),
	).toBeNull()
})
