import { expect, test } from 'vitest'
import {
	applyLimitOverrides,
	isLimitOverrideResource,
	parseLimitOverrideKey,
	parseEntitlementLadder,
	planLimits,
	proCreditsPlanLimits,
	resolveCreditWalletState,
	resolveEntitlementLadderAfterPaidAccessChange,
	resolveEntitlementLimit,
	resolveWeeklyEntitlementLimit,
	resolvePlanLimit,
	resolvePlanLimits,
	resolveWeeklyPlanLimit,
	unlimitedLimit,
	type UserEntitlement,
} from './plans.ts'

type LimitArgs = Parameters<typeof resolvePlanLimit>
type LadderInput = Parameters<
	typeof resolveEntitlementLadderAfterPaidAccessChange
>[0]

// [expected, ...resolvePlanLimit args]
function limitMismatches(cases: Array<[number, ...LimitArgs]>) {
	return cases.filter(([want, ...args]) => resolvePlanLimit(...args) !== want)
}

test('resolvePlanLimit uses public numbers unless the legacy ladder applies', () => {
	expect(
		limitMismatches([
			[150, 'free', 'execute_unique_workers_per_day'],
			[500, 'standard', 'execute_unique_workers_per_day'],
			[500, 'standard', 'execute_unique_workers_per_day', 'public'],
			[500, 'standard', 'execute_unique_workers_per_day', 'legacy'],
			[1_500, 'pro', 'execute_unique_workers_per_day'],
			[50_000, 'pro', 'outbound_fetches_per_day'],
			[150, 'pro', 'scheduled_jobs', 'legacy'],
			[75, 'pro', 'scheduled_jobs', 'public'],
			[150, 'free', 'execute_unique_workers_per_day', 'legacy'],
			[25_000, 'max', 'execute_unique_workers_per_day', 'legacy'],
		]),
	).toEqual([])
	expect(resolvePlanLimits('standard', 'legacy').minJobIntervalMs).toBe(0)
	expect(resolvePlanLimits('pro', 'public').minJobIntervalMs).toBe(
		5 * 60 * 1000,
	)
})

test('public Free/Standard/Pro have weekly execute and outbound windows; max and legacy do not', () => {
	for (const plan of ['free', 'standard', 'pro'] as const) {
		for (const resource of [
			'execute_unique_workers_per_day',
			'outbound_fetches_per_day',
		] as const) {
			expect(resolveWeeklyPlanLimit(plan, resource)).toBeGreaterThan(0)
		}
	}
	expect([
		resolveWeeklyPlanLimit('max', 'execute_unique_workers_per_day'),
		resolveWeeklyPlanLimit(
			'standard',
			'execute_unique_workers_per_day',
			'legacy',
		),
		resolveWeeklyPlanLimit('pro', 'outbound_fetches_per_day', 'legacy'),
		resolveWeeklyPlanLimit('free', 'job_runs_per_day'),
		resolveWeeklyPlanLimit('free', 'automation_invocations_per_day'),
	]).toEqual([null, null, null, null, null])
})

test('parseEntitlementLadder treats blank as public and rejects unknown names', () => {
	expect([null, undefined, '', 'legacy'].map(parseEntitlementLadder)).toEqual([
		'public',
		'public',
		'public',
		'legacy',
	])
	expect(() => parseEntitlementLadder('v1')).toThrow(
		/not a registered ladder name/,
	)
})

test('legacy ladder survives continuous paid access and same-plan renews; cancel, plan, or price change drops it', () => {
	const ladder = (
		currentLadder: LadderInput['currentLadder'],
		manualPlan: LadderInput['manualPlan'],
		previousStripePlan: LadderInput['previousStripePlan'],
		nextStripePlan: LadderInput['nextStripePlan'],
		prices?: [string | null, string | null],
	): LadderInput => ({
		currentLadder,
		manualPlan,
		previousStripePlan,
		nextStripePlan,
		...(prices && {
			previousStripePriceId: prices[0],
			nextStripePriceId: prices[1],
		}),
	})
	const cases: Array<[LadderInput, 'legacy' | 'public']> = [
		[ladder('legacy', 'free', 'standard', 'standard'), 'legacy'],
		[ladder('legacy', 'free', 'pro', 'pro'), 'legacy'],
		[ladder('legacy', 'pro', null, null), 'legacy'],
		[ladder('legacy', 'free', 'standard', null), 'public'],
		[ladder('public', 'free', null, 'pro'), 'public'],
		[ladder('public', 'pro', null, null), 'public'],
		// Same-plan renew keeps legacy, including the first price observation.
		[
			ladder('legacy', 'free', 'pro', 'pro', ['price_pro', 'price_pro']),
			'legacy',
		],
		[ladder('legacy', 'free', 'pro', 'pro', [null, 'price_pro']), 'legacy'],
		// Plan or price change drops legacy; resubscribe stays public.
		[
			ladder('legacy', 'free', 'standard', 'pro', [
				'price_standard',
				'price_pro',
			]),
			'public',
		],
		[
			ladder('legacy', 'free', 'pro', 'pro', [
				'price_pro_month',
				'price_pro_year',
			]),
			'public',
		],
		[
			ladder('legacy', 'free', 'pro', 'pro', ['price_pro_29', 'price_pro_49']),
			'public',
		],
		[ladder('public', 'free', null, 'pro', [null, 'price_pro']), 'public'],
	]
	expect(
		cases.filter(
			([input, want]) =>
				resolveEntitlementLadderAfterPaidAccessChange(input) !== want,
		),
	).toEqual([])
})

test('credit wallet state: only an eligible Pro wallet counts; balance > 0 funds it', () => {
	expect(
		resolveCreditWalletState({
			plan: 'pro',
			creditsEligible: true,
			balanceMicroUsd: 1,
		}),
	).toBe('funded')
	for (const balanceMicroUsd of [0, -4_000, null, undefined, Number.NaN]) {
		expect(
			resolveCreditWalletState({
				plan: 'pro',
				creditsEligible: true,
				balanceMicroUsd,
			}),
		).toBe('empty')
	}
	// Retired Pro/Standard, Free, and a manual max never get a wallet.
	for (const plan of ['free', 'standard', 'max'] as const) {
		expect(
			resolveCreditWalletState({
				plan,
				creditsEligible: true,
				balanceMicroUsd: 10_000_000,
			}),
		).toBe('none')
	}
	expect(
		resolveCreditWalletState({
			plan: 'pro',
			creditsEligible: false,
			balanceMicroUsd: 10_000_000,
		}),
	).toBe('none')
})

test('purchasable Pro has Max stock always; empty wallet keeps the full Pro include; funded raises ceilings', () => {
	const empty = resolvePlanLimits('pro', 'public', 'empty')
	expect(empty).toEqual(proCreditsPlanLimits)
	expect(
		limitMismatches([
			[10_000, 'pro', 'saved_packages', 'public', 'empty'],
			[10_000, 'pro', 'secrets', 'public', 'empty'],
			[5_000, 'pro', 'scheduled_jobs', 'public', 'empty'],
			[10_000, 'pro', 'repos', 'public', 'empty'],
			[20_000, 'pro', 'repo_sessions', 'public', 'empty'],
			[100 * 1024 * 1024 * 1024, 'pro', 'storage_bytes', 'public', 'empty'],
			[200, 'pro', 'concurrent_workflows', 'public', 'empty'],
			[500, 'pro', 'execute_unique_workers_per_day', 'public', 'empty'],
			[15_000, 'pro', 'outbound_fetches_per_day', 'public', 'empty'],
			[1_500, 'pro', 'job_runs_per_day', 'public', 'empty'],
			[10_000, 'pro', 'automation_invocations_per_day', 'public', 'empty'],
			[200, 'pro', 'email_sends_per_day', 'public', 'empty'],
			[1_000, 'pro', 'email_receives_per_day', 'public', 'empty'],
			[25_000, 'pro', 'execute_unique_workers_per_day', 'public', 'funded'],
			[200, 'pro', 'email_sends_per_day', 'public', 'funded'],
		]),
	).toEqual([])
	expect([
		resolveWeeklyPlanLimit(
			'pro',
			'execute_unique_workers_per_day',
			'public',
			'empty',
		),
		resolveWeeklyPlanLimit(
			'pro',
			'outbound_fetches_per_day',
			'public',
			'empty',
		),
	]).toEqual([1_200, 40_000])
	// Never below Free on any limit, at $0.
	const belowFree = (
		Object.keys(planLimits.free) as Array<keyof typeof planLimits.free>
	).filter((key) => {
		const free = planLimits.free[key]
		const pro = empty[key]
		if (key === 'minJobIntervalMs') return (pro ?? 0) > (free ?? 0)
		return pro !== null && free !== null && pro < free
	})
	expect(belowFree).toEqual([])
	expect(empty.minJobIntervalMs).toBe(15 * 60 * 1000)
	expect(empty.maxUniqueWorkerDaysPerMonth).toBe(350)
	expect(empty.maxDurableObjectRowsReadPerMonth).toBe(5_000_000_000)

	// Retired $49 Pro keeps its own table.
	expect(resolvePlanLimits('pro', 'public', 'none')).toEqual(planLimits.pro)

	// Funded keeps the same Max stock as empty; only rates rise.
	expect(resolvePlanLimits('pro', 'public', 'funded')).toMatchObject({
		maxSavedPackages: 10_000,
		maxSecrets: 10_000,
		maxConcurrentWorkflows: 200,
		maxOutboundFetchesPerDay: 750_000,
		maxOutboundFetchesPerWeek: 2_000_000,
		maxJobRunsPerDay: 40_000,
		maxAutomationInvocationsPerDay: 200_000,
		minJobIntervalMs: 15 * 60 * 1000,
		maxUniqueWorkerDaysPerMonth: 350,
		maxDurableObjectRowsReadPerMonth: 5_000_000_000,
	})
	expect(
		resolveWeeklyPlanLimit(
			'pro',
			'execute_unique_workers_per_day',
			'public',
			'funded',
		),
	).toBe(60_000)
	// Non-credits-eligible Pro and non-Pro tables are unchanged by wallet state.
	expect(resolvePlanLimits('free', 'public', 'funded')).toEqual(planLimits.free)
	expect(resolvePlanLimits('max', 'public', 'funded')).toEqual(planLimits.max)
})

test('purchasable Pro rates pool across paid seats; funded ceilings scale with seats; stock and Free do not', () => {
	expect(
		limitMismatches([
			[1_500, 'pro', 'execute_unique_workers_per_day', 'public', 'empty', 3],
			[45_000, 'pro', 'outbound_fetches_per_day', 'public', 'empty', 3],
			[4_500, 'pro', 'job_runs_per_day', 'public', 'empty', 3],
			[10_000, 'pro', 'saved_packages', 'public', 'empty', 3],
			[200, 'pro', 'email_sends_per_day', 'public', 'empty', 3],
			[75_000, 'pro', 'execute_unique_workers_per_day', 'public', 'funded', 3],
			// 45,000 × 50 and seats × 750,000 agree, like execute.
			[2_250_000, 'pro', 'outbound_fetches_per_day', 'public', 'funded', 3],
			[200, 'pro', 'concurrent_workflows', 'public', 'funded', 3],
			[150, 'free', 'execute_unique_workers_per_day', 'public', 'none', 3],
			[1_500, 'pro', 'execute_unique_workers_per_day', 'public', 'none', 3],
		]),
	).toEqual([])
	expect([
		resolveWeeklyPlanLimit(
			'pro',
			'execute_unique_workers_per_day',
			'public',
			'empty',
			3,
		),
		resolveWeeklyPlanLimit(
			'pro',
			'execute_unique_workers_per_day',
			'public',
			'funded',
			3,
		),
		resolveWeeklyPlanLimit(
			'pro',
			'outbound_fetches_per_day',
			'public',
			'funded',
			3,
		),
	]).toEqual([3_600, 180_000, 6_000_000])
	expect(resolvePlanLimits('free', 'public', 'none', 3)).toEqual({
		...planLimits.free,
		maxExecuteCallsPerMinute: 900,
	})
	// Unknown or fractional seat counts never shrink the pool below one seat.
	expect(resolvePlanLimits('pro', 'public', 'empty', 0)).toEqual(
		proCreditsPlanLimits,
	)
	expect(resolvePlanLimits('pro', 'public', 'empty', Number.NaN)).toEqual(
		proCreditsPlanLimits,
	)
	// Runaway brake: seats × 300 on every plan; not credits-unlocked.
	expect([
		resolvePlanLimit('free', 'execute_calls_per_minute'),
		resolvePlanLimit('pro', 'execute_calls_per_minute', 'public', 'empty', 3),
		resolvePlanLimit('pro', 'execute_calls_per_minute', 'public', 'funded', 3),
		resolvePlanLimit('max', 'execute_calls_per_minute', 'public', 'none', 2),
	]).toEqual([300, 900, 900, 600])
})

test('limit overrides only raise caps, skip expired entries, and never add a missing weekly window', () => {
	const now = new Date('2026-10-10T12:00:00.000Z')
	const pro: UserEntitlement = {
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'funded',
		seats: 1,
	}
	const legacy: UserEntitlement = {
		plan: 'standard',
		ladder: 'legacy',
		creditWallet: 'none',
	}
	const withOverrides = (
		entitlement: UserEntitlement,
		limitOverrides: UserEntitlement['limitOverrides'],
	): UserEntitlement => ({ ...entitlement, limitOverrides })

	expect(resolveEntitlementLimit(pro, 'outbound_fetches_per_day', now)).toBe(
		resolvePlanLimit('pro', 'outbound_fetches_per_day', 'public', 'funded', 1),
	)
	const raised = withOverrides(pro, [
		{ key: 'outbound_fetches_per_day', value: 1_000_000, expiresAt: null },
		{ key: 'outbound_fetches_per_week', value: 'unlimited', expiresAt: null },
		{ key: 'job_runs_per_day', value: 1, expiresAt: null },
		{
			key: 'automation_invocations_per_day',
			value: 9_000_000,
			expiresAt: '2026-10-10T11:59:59.999Z',
		},
		{
			key: 'email_sends_per_day',
			value: 9_000,
			expiresAt: '2026-10-11T00:00:00.000Z',
		},
	])
	expect([
		resolveEntitlementLimit(raised, 'outbound_fetches_per_day', now),
		resolveWeeklyEntitlementLimit(raised, 'outbound_fetches_per_day', now),
		resolveEntitlementLimit(raised, 'job_runs_per_day', now),
		resolveEntitlementLimit(raised, 'automation_invocations_per_day', now),
		resolveEntitlementLimit(raised, 'email_sends_per_day', now),
	]).toEqual([
		1_000_000,
		unlimitedLimit,
		resolvePlanLimit('pro', 'job_runs_per_day', 'public', 'funded', 1),
		resolvePlanLimit(
			'pro',
			'automation_invocations_per_day',
			'public',
			'funded',
			1,
		),
		9_000,
	])

	// Legacy ladders have no weekly windows; an override does not add one.
	const legacyLimits = resolvePlanLimits('standard', 'legacy', 'none')
	expect(legacyLimits.maxOutboundFetchesPerWeek).toBeNull()
	expect(
		applyLimitOverrides(
			legacyLimits,
			[{ key: 'outbound_fetches_per_week', value: 5, expiresAt: null }],
			now,
		).maxOutboundFetchesPerWeek,
	).toBeNull()
	expect(
		resolveWeeklyEntitlementLimit(
			withOverrides(legacy, [
				{ key: 'outbound_fetches_per_week', value: 5, expiresAt: null },
			]),
			'outbound_fetches_per_day',
			now,
		),
	).toBeNull()
})

test('limit override keys parse strictly and map to overridable resources', () => {
	expect(parseLimitOverrideKey('saved_packages')).toBeNull()
	expect(parseLimitOverrideKey(undefined)).toBeNull()
	expect(isLimitOverrideResource('outbound_fetches_per_day')).toBe(true)
	expect(isLimitOverrideResource('saved_packages')).toBe(false)
})
