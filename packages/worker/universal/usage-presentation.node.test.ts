import { expect, test } from 'vitest'
import {
	formatCappedPercent,
	formatOnCreditsMicroUsd,
	includeBarPercent,
	includedComputeSummary,
	presentIncludedCompute,
	presentIncludedComputeMeter,
	resolveCreditsAlarm,
	toAccountActivity,
} from './usage-presentation.ts'

const overHundredPercent = /\b(?:1(?:0[1-9]|[1-9]\d)|[2-9]\d\d|\d{4,})%/

function allCopy(values: Array<unknown>) {
	return JSON.stringify(values)
}

test('include bars and percents never read above 100%', () => {
	expect(
		[0, 0.42, 1, 517 / 50, 125.05, Number.NaN].map(includeBarPercent),
	).toEqual([0, 42, 100, 100, 100, 0])
	expect([10.34, 0.9, null].map(formatCappedPercent)).toEqual([
		'100%',
		'90%',
		'—',
	])
})

test('dollars on credits use cents from $1 up and keep sub-cent charges visible', () => {
	expect(
		[4_000, 200_000, 6_580_000, 173_672_000, 1_234_567_890].map(
			formatOnCreditsMicroUsd,
		),
	).toEqual(['$0.004', '$0.20', '$6.58', '$173.67', '$1,234.57'])
})

test('Free Worker compute is informational: no bar, no include status, never charged', () => {
	const meter = presentIncludedComputeMeter({
		resource: 'unique_worker_days',
		current: 517,
		include: 50,
		plan: 'free',
		creditWallet: 'none',
	})
	expect(meter).toMatchObject({
		label: 'Worker compute',
		informational: true,
		barPercent: 0,
		tone: 'calm',
		status: 'Informational · never charged on Free',
		onCreditsMicroUsd: 0,
	})
	const summary = includedComputeSummary({
		plan: 'free',
		creditWallet: 'none',
		meters: [meter],
	})
	expect(summary).toContain('execute caps are your limit')
	expect(allCopy([meter, summary])).not.toMatch(overHundredPercent)
})

test('funded Pro past include is calm dollars on credits with a full bar', () => {
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
		barPercent: 100,
		pastInclude: true,
		tone: 'calm',
		// (43,768 − 350) × $0.004 = $173.67
		onCreditsMicroUsd: 173_672_000,
		status: 'Include used · $173.67 on credits',
	})
	expect(meters[1]).toMatchObject({
		barPercent: 20,
		tone: 'calm',
		status: '20% of include',
	})
	const summary = includedComputeSummary({
		plan: 'pro',
		creditWallet: 'funded',
		meters,
	})
	expect(summary).toBe(
		"Past this month's include, usage runs on credits: $173.67 so far.",
	)
	expect(allCopy([meters, summary])).not.toMatch(overHundredPercent)
})

test('empty Pro wallet near or past include gets attention; retired plans stay calm', () => {
	const workerDays = (
		current: number,
		include: number,
		plan: 'pro' | 'standard',
		creditWallet: 'empty' | 'funded' | 'none',
	) =>
		presentIncludedComputeMeter({
			resource: 'unique_worker_days',
			current,
			include,
			plan,
			creditWallet,
		})
	expect(workerDays(300, 350, 'pro', 'empty').tone).toBe('attention')
	expect(workerDays(300, 350, 'pro', 'funded').tone).toBe('calm')
	expect(workerDays(400, 350, 'pro', 'empty')).toMatchObject({
		barPercent: 100,
		tone: 'attention',
		status: 'Include used · add credits to keep going',
		onCreditsMicroUsd: 0,
	})
	expect(workerDays(4_000, 1_000, 'standard', 'none')).toMatchObject({
		barPercent: 100,
		tone: 'calm',
		informational: false,
		status: 'Include used · not charged',
	})
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

	// Healthy funded wallet past include: credits doing their job, no alarm.
	expect(
		alarm({
			creditWallet: 'funded',
			meters: past,
			balanceMicroUsd: 40_000_000,
		}),
	).toBeNull()
	// Free and other wallet-less plans never alarm on compute.
	expect(
		alarm({
			creditWallet: 'none',
			meters: [{ current: 517, include: 50 }],
			canBuyCredits: false,
			autoRefill: null,
		}),
	).toBeNull()
	// Empty wallet within include with room to spare: nothing to say.
	expect(
		alarm({
			creditWallet: 'empty',
			meters: within,
		}),
	).toBeNull()

	expect(
		alarm({
			creditWallet: 'empty',
			meters: past,
		}),
	).toMatchObject({
		kind: 'include_used_no_credits',
		tone: 'warn',
		action: { label: 'Add credits', href: '#credits' },
	})
	expect(
		alarm({
			creditWallet: 'empty',
			meters: [{ current: 300, include: 350 }],
			canBuyCredits: false,
			autoRefill: null,
		}),
	).toMatchObject({
		kind: 'include_nearly_used_no_credits',
		tone: 'info',
		body: expect.stringContaining(
			'Buying credits requires a paid Pro subscription.',
		),
		action: { label: 'Manage credits' },
	})
	expect(
		alarm({
			creditWallet: 'empty',
			meters: past,
			canBuyCredits: false,
			autoRefill: null,
		}),
	).toMatchObject({
		kind: 'include_used_no_credits',
		tone: 'warn',
		body: expect.stringContaining(
			'Buying credits requires a paid Pro subscription.',
		),
		action: { label: 'Manage credits', href: '#credits' },
	})
	expect(
		alarm({
			creditWallet: 'empty',
			meters: past,
			canBuyCredits: false,
			hasPaidProSubscription: true,
			autoRefill: null,
		}),
	).toMatchObject({
		kind: 'include_used_no_credits',
		body: expect.stringContaining(
			'Buying credits is currently unavailable for this account.',
		),
		action: { label: 'Manage credits' },
	})
	expect(
		alarm({
			creditWallet: 'funded',
			meters: past,
			balanceMicroUsd: 3_000_000,
		}),
	).toMatchObject({
		kind: 'credits_low',
		body: expect.stringContaining('$3.00'),
		action: { label: 'Add credits' },
	})
	expect(
		alarm({
			creditWallet: 'funded',
			meters: past,
			balanceMicroUsd: 3_000_000,
			canBuyCredits: false,
			autoRefill: null,
		}),
	).toMatchObject({
		kind: 'credits_low',
		action: { label: 'Manage credits', href: '#credits' },
	})
	// Low balance within the include is not an alarm (nothing stops).
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
	).toMatchObject({ kind: 'auto_refill_capped', tone: 'warn' })
	// Auto-refill with room under the cap handles a low balance itself.
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

test('activity lists executions and runs in a fixed order with safe counts', () => {
	expect(
		toAccountActivity({
			month: '2026-09',
			counts: { execute: 1_234, job_run: -3, package_export: 7.9 },
		}),
	).toEqual({
		month: '2026-09',
		metrics: [
			{ metric: 'execute', label: 'Code executions', count: 1_234 },
			{ metric: 'job_run', label: 'Job runs', count: 0 },
			{ metric: 'workflow_run', label: 'Workflow runs', count: 0 },
			{ metric: 'package_export', label: 'Package calls', count: 7 },
		],
	})
})
