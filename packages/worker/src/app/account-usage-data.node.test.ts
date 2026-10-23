import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { type DailyEntitlementResource } from '#universal/plans.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { loadAccountUsageData } from '#app/account-usage-data.ts'

const now = new Date('2026-07-25T12:00:00.000Z')

type UsageDbInput = {
	userId: number
	email: string
	plan: string
	stripePlan?: string | null
	entitlementLadder?: string | null
	stripeCustomerId?: string | null
	packageCount?: number
	uniqueWorkerDays?: number
	durableObjectRowsRead?: number
	activity?: Record<string, number>
	creditsEligible?: boolean
	/** Admin-set wallet eligibility; never written by Stripe. */
	adminCreditsEligible?: boolean
	creditBalanceMicroUsd?: number
	giftExpiresAt?: string
}

function createUsageTestDb(
	input: UsageDbInput,
	stableUserId: string,
	counters: { creditWalletQueries: number } = { creditWalletQueries: 0 },
) {
	const rollups = [
		['dynamic_worker_day', input.uniqueWorkerDays ?? 0],
		['durable_object_rows_read', input.durableObjectRowsRead ?? 0],
	].filter(([, count]) => Number(count) > 0)
	return {
		counters,
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			const statement = {
				async first<T>() {
					if (
						normalized.includes('from users') &&
						(normalized.includes('where id') || normalized.includes('u.id ='))
					) {
						return {
							id: input.userId,
							plan: input.plan,
							stripe_plan: input.stripePlan ?? null,
							entitlement_ladder: input.entitlementLadder ?? 'public',
							stripe_credits_eligible: input.creditsEligible ? 1 : 0,
							admin_credits_eligible: input.adminCreditsEligible ? 1 : 0,
							second_agent_standard_gift_expires_at:
								input.giftExpiresAt ?? null,
							referral_standard_credit_expires_at: null,
							stable_user_id: stableUserId,
							personal_org_id: stableUserId,
							org_id: stableUserId,
							username: 'usage-user',
							stripe_customer_id: input.stripeCustomerId ?? null,
						} as T
					}
					if (
						normalized.includes('from orgs') &&
						!normalized.includes('from users') &&
						normalized.includes('where id')
					) {
						return {
							slug: 'acme',
							display_name: 'Acme',
							plan: input.plan,
							stripe_plan: input.stripePlan ?? null,
							entitlement_ladder: input.entitlementLadder ?? 'public',
							stripe_credits_eligible: input.creditsEligible ? 1 : 0,
							admin_credits_eligible: input.adminCreditsEligible ? 1 : 0,
							second_agent_standard_gift_expires_at: null,
							referral_standard_credit_expires_at: null,
							stripe_customer_id: input.stripeCustomerId ?? null,
						} as T
					}
					if (normalized.includes('from credit_wallets')) {
						counters.creditWalletQueries += 1
						return { balance_micro_usd: input.creditBalanceMicroUsd ?? 0 } as T
					}
					if (normalized.includes('from saved_packages')) {
						return { count: input.packageCount ?? 0 } as T
					}
					if (normalized.includes('select 1 as present from users')) {
						return { present: 1 } as T
					}
					if (normalized.includes('count(*)') || normalized.includes('sum(')) {
						return { count: 0, total: 0, bytes: 0 } as T
					}
					return null
				},
				async all() {
					if (normalized.includes('from usage_attribution_daily')) {
						return { results: [] }
					}
					if (!normalized.includes('from usage_rollups')) return { results: [] }
					return {
						results: [...rollups, ...Object.entries(input.activity ?? {})].map(
							([metric, event_count]) => ({ metric, event_count }),
						),
					}
				},
			}
			return { bind: () => statement }
		},
	} as unknown as D1Database & { counters: { creditWalletQueries: number } }
}

/**
 * Loads usage for a seeded account. `daily` seeds authoritative UserMeter
 * counters for today; `activeWorkflows` seeds the RunLog count for this user
 * (another user's 99 workflows must never leak in).
 */
async function loadUsage(
	input: UsageDbInput,
	options: {
		env?: Record<string, unknown>
		mailboxMessageCount?: number
		daily?: Partial<Record<DailyEntitlementResource, number>>
		storageBytes?: number
		activeWorkflows?: number
	} = {},
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	const db = createUsageTestDb(input, stableUserId)
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const countMessages = async () => ({
		total: options.mailboxMessageCount ?? 0,
	})
	for (const [resource, count] of Object.entries(options.daily ?? {})) {
		await meter.seed({
			userId: stableUserId,
			resource: resource as DailyEntitlementResource,
			day: utcDayKey(now),
			count,
		})
	}
	if (options.storageBytes !== undefined) {
		await meter.seedStorageBytes({
			userId: stableUserId,
			bytes: options.storageBytes,
		})
	}
	if (options.activeWorkflows !== undefined) {
		runLog.setActiveWorkflowCount(stableUserId, options.activeWorkflows)
		runLog.setActiveWorkflowCount('other-user', 99)
	}
	const data = await loadAccountUsageData({
		env: {
			APP_DB: db,
			...options.env,
			...meter.env,
			...runLog.env,
			REPO_SESSION_INDEX:
				createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
			MAILBOX: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ countMessages }),
			},
		} as unknown as Env,
		userId: input.userId,
		org: {
			id: stableUserId as never,
			slug: 'usage-user',
			displayName: null,
			personal: true,
		},
		now,
	})
	const row = (resource: string) =>
		data?.entitlementConsumption.find((entry) => entry.resource === resource)
	const meterFor = (resource: string) =>
		data?.computeOverage.meters.find((entry) => entry.resource === resource)
	return {
		data,
		row,
		meterFor,
		creditWalletQueries: db.counters.creditWalletQueries,
	}
}

test('loadAccountUsageData returns plan rows and authoritative UserMeter daily counts', async () => {
	const baseline = await loadUsage({
		userId: 7,
		email: 'usage@example.com',
		plan: 'free',
		packageCount: 2,
	})
	expect(baseline.data).toMatchObject({
		ok: true,
		plan: 'free',
		manualPlan: 'free',
		stripePlan: null,
		today: '2026-07-25',
	})
	expect(baseline.row('saved_packages')?.current).toBe(2)
	expect(baseline.row('concurrent_workflows')?.current).toBe(0)
	expect(baseline.data?.computeOverage.creditsStatus).toBe('within_include')
	expect(baseline.data?.computeOverage.creditWallet).toBe('none')
	expect(baseline.data?.computeOverage.meters).toHaveLength(2)

	const bootstrapped = await loadUsage(
		{
			userId: 8,
			email: 'usage-bootstrap@example.com',
			plan: 'pro',
			packageCount: 1,
		},
		{ daily: { email_sends_per_day: 17, execute_unique_workers_per_day: 91 } },
	)
	expect(bootstrapped.row('email_sends_per_day')?.current).toBe(17)
	expect(bootstrapped.row('execute_unique_workers_per_day')?.current).toBe(91)
	expect(bootstrapped.row('saved_packages')?.current).toBe(1)

	const warm = await loadUsage(
		{
			userId: 9,
			email: 'usage-meter@example.com',
			plan: 'pro',
			packageCount: 4,
		},
		{
			mailboxMessageCount: 7,
			activeWorkflows: 3,
			daily: {
				email_sends_per_day: 101,
				email_receives_per_day: 202,
				execute_unique_workers_per_day: 303,
				outbound_fetches_per_day: 404,
			},
		},
	)
	expect(warm.row('email_sends_per_day')?.current).toBe(101)
	expect(warm.row('email_receives_per_day')?.current).toBe(202)
	expect(warm.row('execute_unique_workers_per_day')?.current).toBe(303)
	expect(warm.row('execute_unique_workers_per_day')?.week).toEqual({
		current: 303,
		limit: 4_000,
		percentOfLimit: 303 / 4_000,
		overEightyPercent: false,
	})
	expect(warm.row('outbound_fetches_per_day')?.current).toBe(404)
	expect(warm.data?.weekStart).toBe('2026-07-20')
	expect(warm.row('concurrent_workflows')?.current).toBe(3)
	expect(warm.row('stored_email_messages')?.current).toBe(7)
	expect(warm.row('saved_packages')?.current).toBe(4)

	const storage = await loadUsage(
		{
			userId: 11,
			email: 'usage-storage@example.com',
			plan: 'pro',
			packageCount: 0,
		},
		{ storageBytes: 4_321 },
	)
	expect(storage.row('storage_bytes')?.current).toBe(4_321)

	const grant = await loadUsage({
		userId: 12,
		email: 'usage-grant@example.com',
		plan: 'max',
		stripePlan: null,
	})
	expect(grant.data).toMatchObject({
		plan: 'max',
		manualPlan: 'max',
		stripePlan: null,
		credits: null,
	})

	const subscribed = await loadUsage({
		userId: 13,
		email: 'usage-sub@example.com',
		plan: 'free',
		stripePlan: 'pro',
	})
	expect(subscribed.data).toMatchObject({
		plan: 'pro',
		manualPlan: 'free',
		stripePlan: 'pro',
	})
})

test('purchasable Pro with credits runs past the include on credits; at $0 it stops at the include', async () => {
	const purchasablePro = {
		plan: 'free',
		stripePlan: 'pro',
		creditsEligible: true,
		uniqueWorkerDays: 400,
	}
	const funded = await loadUsage({
		...purchasablePro,
		userId: 24,
		email: 'usage-credits@example.com',
		creditBalanceMicroUsd: 10_000_000,
		stripeCustomerId: 'cus_credits',
	})
	expect(funded.creditWalletQueries).toBe(1)
	expect(funded.data?.computeOverage.creditWallet).toBe('funded')
	expect(funded.data?.computeOverage.creditsStatus).toBe('debiting_credits')
	expect(funded.data?.computeOverage.creditsCostMicroUsd).toBe(50 * 4_000)
	expect(funded.data?.creditsAlarm).toBeNull()
	expect(funded.data?.canBuyCredits).toBe(true)
	expect(funded.data?.credits).toMatchObject({
		eligible: true,
		configured: false,
		canBuyCredits: false,
		balanceMicroUsd: 10_000_000,
		hasCredits: true,
		recent: [],
	})
	const fundedCredits = funded.data?.credits
	expect(
		fundedCredits?.eligible ? fundedCredits.debitMeters[0] : null,
	).toMatchObject({
		meter: 'unique_worker_days',
		used: 400,
		pastInclude: 50,
		estCreditsMicroUsd: 50 * 4_000,
	})
	expect(funded.data?.includedCompute[0]).toMatchObject({
		barPercent: 100,
		tone: 'calm',
	})
	expect(
		funded.data?.warnings.filter(
			(row) => row.resource === 'unique_worker_days',
		),
	).toEqual([])
	expect(funded.row('execute_unique_workers_per_day')?.limit).toBe(25_000)
	expect(funded.row('email_sends_per_day')?.limit).toBe(200)

	const empty = await loadUsage(
		{
			...purchasablePro,
			userId: 25,
			email: 'usage-credits-empty@example.com',
			creditBalanceMicroUsd: 0,
			stripeCustomerId: 'cus_credits_empty',
		},
		{ env: { STRIPE_SECRET_KEY: 'sk_test_usage' } },
	)
	expect(empty.data?.computeOverage.creditWallet).toBe('empty')
	expect(empty.data?.computeOverage.creditsStatus).toBe('add_credits')
	expect(empty.data?.canBuyCredits).toBe(true)
	expect(empty.data?.credits).toMatchObject({
		eligible: true,
		balanceMicroUsd: 0,
		hasCredits: false,
	})
	expect(empty.data?.creditsAlarm).toMatchObject({
		kind: 'include_used_no_credits',
	})
	expect(empty.data?.includedCompute[0]).toMatchObject({
		barPercent: 100,
		tone: 'attention',
	})
	expect(
		empty.data?.warnings.filter((row) => row.resource === 'unique_worker_days'),
	).toEqual([])
	expect(empty.row('execute_unique_workers_per_day')?.limit).toBe(500)

	// Without a Stripe customer nobody can buy: the alarm and the Credits
	// section agree.
	const noCustomer = await loadUsage(
		{
			...purchasablePro,
			userId: 27,
			email: 'usage-credits-no-customer@example.com',
			creditBalanceMicroUsd: 0,
			stripeCustomerId: null,
		},
		{ env: { STRIPE_SECRET_KEY: 'sk_test_usage' } },
	)
	expect(noCustomer.data?.computeOverage.creditWallet).toBe('empty')
	expect(noCustomer.data?.canBuyCredits).toBe(false)
	expect(noCustomer.data?.creditsAlarm).toMatchObject({
		kind: 'include_used_no_credits',
		action: { label: 'Manage credits', href: '#credits' },
	})
	expect(noCustomer.data?.credits).toMatchObject({
		eligible: true,
		configured: true,
		canBuyCredits: false,
	})
})

test('gift Pro keeps retired Pro ceilings without a wallet and cannot buy credits', async () => {
	const { data, row, meterFor } = await loadUsage({
		userId: 26,
		email: 'usage-gift@example.com',
		plan: 'free',
		giftExpiresAt: '2026-08-25T00:00:00.000Z',
		uniqueWorkerDays: 400,
	})
	expect(data?.plan).toBe('pro')
	expect(data?.computeOverage.creditWallet).toBe('none')
	expect(data?.computeOverage.creditsStatus).toBe('within_include')
	expect(data?.canBuyCredits).toBe(false)
	expect(data?.credits).toMatchObject({ eligible: false })
	expect(meterFor('unique_worker_days')).toMatchObject({
		include: 2_000,
	})
	expect(meterFor('durable_object_rows_read')).toMatchObject({
		include: 20_000_000_000,
	})
	expect(row('execute_unique_workers_per_day')?.limit).toBe(1_500)
})

test('team org usage loads plan and wallet by org id, not the viewer person', async () => {
	const teamOrgId = 'org-acme-usage'
	const input: UsageDbInput = {
		userId: 40,
		email: 'team-owner@example.com',
		plan: 'pro',
		stripePlan: 'pro',
		creditsEligible: true,
		stripeCustomerId: 'cus_acme',
		creditBalanceMicroUsd: 5_000_000,
		packageCount: 3,
	}
	const db = createUsageTestDb(input, teamOrgId)
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const data = await loadAccountUsageData({
		env: {
			APP_DB: db,
			...meter.env,
			...runLog.env,
			REPO_SESSION_INDEX:
				createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
			MAILBOX: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ countMessages: async () => ({ total: 0 }) }),
			},
		} as unknown as Env,
		userId: input.userId,
		org: {
			id: teamOrgId as never,
			slug: 'acme',
			displayName: 'Acme',
			personal: false,
		},
		now,
	})
	expect(data).toMatchObject({
		ok: true,
		plan: 'pro',
		stripePlan: 'pro',
		canBuyCredits: true,
	})
	expect(data?.credits).toMatchObject({
		eligible: true,
		balanceMicroUsd: 5_000_000,
	})
	expect(
		data?.entitlementConsumption.find((r) => r.resource === 'saved_packages')
			?.current,
	).toBe(3)
})
