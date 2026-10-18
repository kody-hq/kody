import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	BudgetLimitError,
	ComputeOverageLimitError,
	EntitlementLimitError,
	buildBudgetLimitMessage,
	buildEntitlementLimitMessage,
	buildEntitlementUpgradeHint,
	buildJobIntervalFloorMessage,
	jobIntervalFloorErrorCode,
	parseBudgetLimitMessage,
	parseComputeOverageLimitMessage,
	parseEntitlementLimitMessage,
	parseJobIntervalFloorMessage,
} from './errors.ts'
import { buildEntitlementHowToReduce } from './resource-visibility.ts'
import {
	creditsUnlockedResources,
	entitlementResources,
	entitlementResourceWindows,
	legacyPlanLimits,
	parseStripePlanName,
	planLimits,
	type DailyEntitlementResource,
} from '#universal/plans.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	consumeExecuteUniqueWorkerDay,
	estimateEntitlementStorageEntryByteDelta,
	findCachedUserAccountByStableUserId,
	getCachedUserEntitlement,
	getCachedUserPlan,
	getUserEntitlement,
	getUserPlan,
	isPayingForCreditsPro,
	readCurrentEntitlementResourceUsage,
	refundDailyEntitlement,
	resolveUserPlanFromRow,
	type EntitlementUsageEnv,
} from './service.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { type UserMeterEnv, userMeterRpc } from './user-meter-client.ts'
import {
	isLiveSeatCountQuery,
	mockLiveSeatCountRow,
} from '#worker/test-support/live-seat-count-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

type TestUser = {
	email: string
	plan: string | null
	stripe_plan?: string | null
	entitlement_ladder?: 'public' | 'legacy' | null
	second_agent_standard_gift_expires_at?: string | null
	referral_standard_credit_expires_at?: string | null
	stable_user_id: string
	/** Distinct personal org id when it differs from stable_user_id. */
	personal_org_id?: string
}

const countedTables = [
	'email_attachments',
	'email_messages',
	'secret_entries',
	'mcp_memories',
	'saved_packages',
	'entity_sources',
	'jobs',
	'repo_sessions',
	'published_bundle_artifacts',
] as const

function createEntitlementsTestDb(
	input: {
		users?: Array<TestUser>
		orgs?: Array<TestUser>
		counts?: Partial<Record<(typeof countedTables)[number], number>>
	} = {},
) {
	const users = input.users ?? []
	// Omitted orgs mirror the fixture people: personal-org billing columns.
	const orgs = input.orgs ?? users
	const counts = input.counts ?? {}
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const byId = (id: unknown) => users.find((row) => row.stable_user_id === id)
	const orgById = (id: unknown) =>
		orgs.find(
			(row) =>
				row.stable_user_id === id ||
				row.personal_org_id === id ||
				(row.personal_org_id == null && row.stable_user_id === id),
		)
	const personalOrgIdFor = (user: TestUser) =>
		user.personal_org_id ?? user.stable_user_id
	const planRow = (user: TestUser | undefined) =>
		user
			? {
					org_id: personalOrgIdFor(user),
					plan: user.plan,
					stripe_plan: user.stripe_plan ?? null,
					entitlement_ladder: user.entitlement_ladder ?? 'public',
					second_agent_standard_gift_expires_at:
						user.second_agent_standard_gift_expires_at ?? null,
					referral_standard_credit_expires_at:
						user.referral_standard_credit_expires_at ?? null,
				}
			: null

	function userMatchesEmailAndOwnerId(
		row: TestUser,
		email: unknown,
		ownerId: unknown,
	) {
		return (
			row.email === email &&
			(row.stable_user_id === ownerId || row.personal_org_id === ownerId)
		)
	}

	function entitlementPlanFirst(query: string, params: Array<unknown>) {
		// Pair match is required: omitted bind params or email-only fixtures
		// must not resolve a plan. Owner id may be person or personal org id.
		if (query.includes('email = ?')) {
			return planRow(
				users.find((row) =>
					userMatchesEmailAndOwnerId(row, params[0], params[1]),
				),
			)
		}
		return planRow(byId(params[0]))
	}

	function first(query: string, params: Array<unknown>) {
		if (query.includes('FROM credit_wallets')) return null
		if (query.includes('FROM org_user_budgets')) return null
		if (
			query.includes('INNER JOIN orgs') &&
			query.includes('email_verified_at')
		) {
			const user = byId(params[0])
			const org = user ? orgById(personalOrgIdFor(user)) : undefined
			if (!user || !org) return null
			return {
				email: user.email,
				plan: org.plan,
				email_verified_at: null,
			}
		}
		// Entitlement read joined to a users identity row.
		if (query.includes('INNER JOIN orgs')) {
			const user = users.find((row) =>
				userMatchesEmailAndOwnerId(row, params[0], params[1]),
			)
			if (!user) return null
			return planRow(orgById(personalOrgIdFor(user)))
		}
		if (query.includes('SELECT email, plan, email_verified_at')) {
			const user = byId(params[0])
			return user
				? { email: user.email, plan: user.plan, email_verified_at: null }
				: null
		}
		if (/FROM orgs(?:\s|$)/.test(query) || /FROM orgs o\b/.test(query)) {
			return planRow(orgById(params[0]))
		}
		if (/FROM users(?:\s|$)/.test(query) || /FROM users u\b/.test(query)) {
			return entitlementPlanFirst(query, params)
		}
		if (query.includes('SELECT 1 AS present FROM users')) {
			if (query.includes('email = ?')) {
				return users.some(
					(row) => row.email === params[0] && row.stable_user_id === params[1],
				)
					? { present: 1 }
					: null
			}
			return byId(String(params[0])) ? { present: 1 } : null
		}
		if (isLiveSeatCountQuery(query)) {
			return mockLiveSeatCountRow()
		}
		const table = countedTables.find((name) => query.includes(`FROM ${name}`))
		if (table) return { count: counts[table] ?? 0 }
		throw new Error(`Unsupported first query: ${query}`)
	}

	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql: query, params })
					return {
						first: async () => first(query, params),
						async all() {
							if (query.includes('FROM org_limit_overrides')) {
								return { results: [] }
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, queries }
}

const plannedEmail = 'planned@example.com'

async function createPlannedUserDb(
	plan: string | null,
	extra: Partial<TestUser> = {},
) {
	const userId = testStableUserIdFromEmail(plannedEmail)
	const users = [
		{ email: plannedEmail, plan, stable_user_id: userId, ...extra },
	]
	// P3: entitlement reads prefer orgs; mirror the planned user as its org.
	return {
		userId,
		users,
		...createEntitlementsTestDb({ users, orgs: users }),
	}
}

async function expectLimitError(promise: Promise<unknown>) {
	const thrown = await promise.then(
		() => null,
		(error: unknown) => error,
	)
	if (!(thrown instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	return thrown
}

type MeterEnv = ReturnType<typeof createInMemoryUserMeterEnv>['env']

async function readMeterDailyCount(
	env: MeterEnv,
	userId: string,
	resource: DailyEntitlementResource,
	now: Date,
) {
	const result = await userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).read({
		resource,
		day: utcDayKey(now),
		now: now.toISOString(),
	})
	return result.outcome === 'ready' ? result.count : 0
}

function userMeterStub(env: MeterEnv, userId: string) {
	return env.USER_METER.get(env.USER_METER.idFromName(userId))
}

function initializeStorageBytes(env: MeterEnv, userId: string, bytes: number) {
	return userMeterStub(env, userId).initializeStorageBytes({
		bytes,
		updatedAt: new Date().toISOString(),
	})
}

test('admin credit eligibility counts only on an effective Pro and never enables buying credits', () => {
	const row = {
		plan: 'pro',
		stripe_plan: null,
		entitlement_ladder: 'public',
		stripe_credits_eligible: 0,
		admin_credits_eligible: 1,
		second_agent_standard_gift_expires_at: null,
		referral_standard_credit_expires_at: null,
	}
	expect(resolveUserPlanFromRow(row).creditsEligible).toBe(true)
	expect(isPayingForCreditsPro(row)).toBe(false)
	for (const override of [
		{ admin_credits_eligible: 0 },
		{ plan: 'max' },
		{ plan: 'free' },
	]) {
		expect(
			resolveUserPlanFromRow({ ...row, ...override }).creditsEligible,
		).toBe(false)
	}
})

test('entitlement limit messages always identify a known plan name', () => {
	const details = {
		code: 'entitlement_limit_exceeded' as const,
		resource: 'concurrent_workflows' as const,
		plan: 'max' as const,
		limit: 100,
		current: 100,
		upgradeHint: buildEntitlementUpgradeHint({
			resource: 'concurrent_workflows',
			plan: 'max',
		}),
	}
	const message = buildEntitlementLimitMessage(details)
	expect(parseEntitlementLimitMessage(message)).toEqual(details)
	expect(details.upgradeHint).not.toMatch(/upgrade/i)

	const weeklyDetails = {
		code: 'entitlement_limit_exceeded' as const,
		resource: 'execute_unique_workers_per_day' as const,
		plan: 'free' as const,
		limit: 400,
		current: 400,
		window: 'week' as const,
		upgradeHint: buildEntitlementUpgradeHint({
			resource: 'execute_unique_workers_per_day',
			plan: 'free',
			window: 'week',
		}),
	}
	expect(
		parseEntitlementLimitMessage(buildEntitlementLimitMessage(weeklyDetails)),
	).toEqual(weeklyDetails)
	expect(weeklyDetails.upgradeHint).toMatch(
		/upgrade your plan at \/@<slug>\/-\/billing/,
	)
	for (const scope of ['this deployment', 'your "enterprise" plan']) {
		expect(
			parseEntitlementLimitMessage(
				`Plan limit reached: ${scope} allows at most 100 concurrent workflows and you currently have 100. hint`,
			),
		).toBeNull()
	}
})

test('rate/compute include hints: $0 Pro adds credits to keep going, Free upgrades', () => {
	const now = new Date('2026-10-10T22:34:00.000Z')
	expect(
		buildEntitlementUpgradeHint({
			resource: 'execute_unique_workers_per_day',
			plan: 'pro',
			creditWallet: 'empty',
			now,
		}),
	).toBe(
		'This daily limit resets at 00:00 UTC, in 1h 26m. Rerun code you already ran today and vary params; repeats are free, or add credits at /account/usage#credits to keep going past your include.',
	)
	expect(buildEntitlementHowToReduce('job_runs_per_day', 'pro', 'empty')).toBe(
		'Run fewer jobs today, space them out, or add credits at /account/usage#credits to keep going past your include.',
	)
	for (const resource of creditsUnlockedResources) {
		expect(
			buildEntitlementUpgradeHint({
				resource,
				plan: 'pro',
				creditWallet: 'empty',
			}),
		).toMatch(
			/add credits at \/account\/usage#credits to keep going past your include\.$/i,
		)
	}
	// Free stays hard-capped: the next step is Pro, not credits.
	expect(
		buildEntitlementUpgradeHint({
			resource: 'execute_unique_workers_per_day',
			plan: 'free',
			now,
		}),
	).toBe(
		'This daily limit resets at 00:00 UTC, in 1h 26m. Rerun code you already ran today and vary params; repeats are free, or upgrade your plan at /@<slug>/-/billing.',
	)
	expect(buildEntitlementHowToReduce('job_runs_per_day', 'free')).toBe(
		'Run fewer jobs today, space them out, or upgrade your plan.',
	)
	// Retired and gift/referral Pro have no wallet: Pro with credits runs past
	// its include.
	for (const plan of ['standard', 'pro'] as const) {
		const hint = buildEntitlementUpgradeHint({
			resource: 'execute_unique_workers_per_day',
			plan,
		})
		expect(hint).toMatch(
			/Pro with prepaid credits at \/account\/usage#credits runs past its include\.$/,
		)
		expect(hint).not.toMatch(/\/account\/billing/)
	}
	// Funded (already at the credits ceiling), or operator max: reduce-only.
	for (const [plan, wallet] of [
		['pro', 'funded'],
		['max', 'none'],
	] as const) {
		const hint = buildEntitlementUpgradeHint({
			resource: 'execute_unique_workers_per_day',
			plan,
			creditWallet: wallet,
			window: 'week',
			now,
		})
		expect(hint).toBe(
			'This weekly limit resets Monday 00:00 UTC, in 1d 1h 26m. Rerun code you already ran today and vary params; repeats are free.',
		)
		expect(hint).not.toMatch(/credits|upgrade/i)
		expect(
			buildEntitlementHowToReduce(
				'execute_unique_workers_per_day',
				plan,
				wallet,
			),
		).not.toMatch(/credits|upgrade/i)
		const denial = new EntitlementLimitError({
			resource: 'execute_unique_workers_per_day',
			plan,
			limit: 400,
			current: 400,
			window: 'week',
			upgradeHint: hint,
		})
		expect(denial.message).toMatch(/^Plan limit reached:/)
	}
	// Stock is on the Pro subscription (not a credits unlock); only Free
	// gets a billing upgrade offer.
	expect(
		buildEntitlementUpgradeHint({ resource: 'saved_packages', plan: 'free' }),
	).toMatch(/\/@<slug>\/-\/billing/)
	for (const plan of ['standard', 'pro', 'max'] as const) {
		expect(
			buildEntitlementUpgradeHint({ resource: 'saved_packages', plan }),
		).not.toMatch(/upgrade|credits/i)
	}
	expect(
		buildEntitlementUpgradeHint({
			resource: 'saved_packages',
			plan: 'pro',
			creditWallet: 'empty',
		}),
	).not.toMatch(/credits/i)
})

test('denial hints follow each resource window: daily meters reset, only standing counts say remove', () => {
	const now = new Date('2026-10-10T23:59:30.000Z')
	for (const resource of entitlementResources) {
		const hint = buildEntitlementUpgradeHint({ resource, plan: 'max', now })
		const window = entitlementResourceWindows[resource]
		expect(
			hint.startsWith('This daily limit resets at 00:00 UTC, in 1m.'),
		).toBe(window === 'utc_day')
		expect(
			hint.startsWith('Remove or finish existing') ||
				hint.startsWith(
					'Delete package or job storage you no longer need, or discard active repo sessions',
				),
		).toBe(window === 'standing')
	}
	expect(
		buildEntitlementUpgradeHint({
			resource: 'outbound_fetches_per_day',
			plan: 'max',
			now,
		}),
	).toBe('This daily limit resets at 00:00 UTC, in 1m.')
	expect(
		buildEntitlementUpgradeHint({
			resource: 'outbound_fetches_per_day',
			plan: 'free',
			window: 'week',
			now: new Date('2026-10-07T12:00:00.000Z'),
		}),
	).toBe(
		'This weekly limit resets Monday 00:00 UTC, in 4d 12h 0m. Upgrade your plan at /@<slug>/-/billing.',
	)
	expect(
		buildEntitlementUpgradeHint({
			resource: 'email_message_bytes',
			plan: 'max',
		}),
	).toBe('Use fewer bytes per email message.')
	expect(
		buildEntitlementUpgradeHint({
			resource: 'execute_calls_per_minute',
			plan: 'max',
		}),
	).toBe('This limit resets when the next minute starts.')
})

test('job interval floor messages parse back to known plan and interval', () => {
	for (const upgradeHint of [
		'Space this job out, or upgrade at /@<slug>/-/billing.',
		'',
		'Space this job out. Then upgrade at /@<slug>/-/billing.',
	]) {
		const details = {
			code: jobIntervalFloorErrorCode,
			plan: 'free' as const,
			minIntervalMs: planLimits.free.minJobIntervalMs,
			upgradeHint,
		}
		expect(
			parseJobIntervalFloorMessage(buildJobIntervalFloorMessage(details)),
		).toEqual(details)
	}
	for (const message of [
		'Your "enterprise" plan cannot run jobs more often than every 15 minutes. hint',
		'Your "free" plan cannot run jobs more often than every often. hint',
	]) {
		expect(parseJobIntervalFloorMessage(message)).toBeNull()
	}
})

test('storage byte entry estimates support net-positive upsert deltas', () => {
	const entry = (value: string) => ({
		key: 'workspace',
		value: { description: 'Workspace slug', value },
	})
	const existing = entry('kent-main-site')
	const delta = (next: string) =>
		estimateEntitlementStorageEntryByteDelta({ next: entry(next), existing })
	expect(delta('kent-main-site')).toBe(0)
	expect(delta('kent')).toBe(0)
	expect(delta('kent-main-site-production')).toBeGreaterThan(0)
})

test('getUserPlan resolves plans, defaults unresolved contexts to free, and rejects invalid stored plans', async () => {
	const userId = testStableUserIdFromEmail(plannedEmail)
	const unknownPlanEmail = 'unknown-plan@example.com'
	const unknownPlanUserId = testStableUserIdFromEmail(unknownPlanEmail)
	const { db, queries } = createEntitlementsTestDb({
		users: [
			{ email: plannedEmail, plan: 'pro', stable_user_id: userId },
			{
				email: unknownPlanEmail,
				plan: 'enterprise-2099',
				stable_user_id: unknownPlanUserId,
			},
		],
	})
	for (const email of [null, undefined, plannedEmail]) {
		expect(
			await getUserPlan(db, { userId: ownerIdFromStored('user-1'), email }),
		).toBe('free')
	}
	expect(queries).toEqual([])

	expect(await getUserPlan(db, { userId, email: plannedEmail })).toBe('pro')
	expect(
		await getUserPlan(db, { userId, email: ' Planned@Example.com ' }),
	).toBe('pro')
	const pairedPlanQuery = [...queries]
		.reverse()
		.find((entry) =>
			/u\.email = \?[\s\S]*u\.stable_user_id = \? OR u\.personal_org_id = \?/.test(
				entry.sql,
			),
		)
	expect(pairedPlanQuery?.params).toEqual([plannedEmail, userId, userId])

	// Background contexts reverse-resolve valid stable ids when their persisted
	// email is blank or missing.
	for (const email of [null, undefined, '   ']) {
		expect(await getUserPlan(db, { userId, email })).toBe('pro')
		const orgPlanQuery = [...queries]
			.reverse()
			.find((entry) => /FROM orgs o WHERE o\.id = \?/.test(entry.sql))
		expect(orgPlanQuery?.params).toEqual([userId])
	}

	// Mismatched email/stable-id pairs fail closed without warning.
	expect(await getUserPlan(db, { userId, email: unknownPlanEmail })).toBe(
		'free',
	)
	await expect(
		getUserPlan(db, { userId: unknownPlanUserId, email: unknownPlanEmail }),
	).rejects.toThrow('Stored plan is not a registered plan name.')
})

test('getUserEntitlement keys wallet seats and overrides by personal org id when distinct', async () => {
	const personId = testStableUserIdFromEmail('distinct-owner@example.com')
	const orgId = testStableUserIdFromEmail('distinct-org@example.com')
	expect(personId).not.toBe(orgId)
	const { db, queries } = createEntitlementsTestDb({
		users: [
			{
				email: 'distinct-owner@example.com',
				plan: 'free',
				stable_user_id: personId,
				personal_org_id: orgId,
			},
		],
		orgs: [
			{
				email: 'distinct-owner@example.com',
				plan: 'free',
				stable_user_id: orgId,
			},
		],
	})
	await getUserEntitlement(db, {
		userId: personId,
		email: 'distinct-owner@example.com',
	})
	const ownerKeyedParams = queries
		.filter(
			(query) =>
				query.sql.includes('FROM org_limit_overrides') ||
				isLiveSeatCountQuery(query.sql),
		)
		.map((query) => query.params[0])
	expect(ownerKeyedParams.length).toBeGreaterThan(0)
	expect(ownerKeyedParams.every((bound) => bound === orgId)).toBe(true)
	expect(ownerKeyedParams.every((bound) => bound !== personId)).toBe(true)
})

test('getUserEntitlement with owner email resolves paid plan when personal org id is distinct', async () => {
	const personId = testStableUserIdFromEmail('ada-distinct@example.com')
	const orgId = testStableUserIdFromEmail('ada-org@example.com')
	expect(personId).not.toBe(orgId)
	const email = 'ada-distinct@example.com'
	const { db } = createEntitlementsTestDb({
		users: [
			{
				email,
				plan: 'pro',
				stripe_plan: 'pro',
				stable_user_id: personId,
				personal_org_id: orgId,
			},
		],
		orgs: [
			{
				email,
				plan: 'pro',
				stripe_plan: 'pro',
				stable_user_id: orgId,
			},
		],
	})
	// Hot paths pass personal org id + owner email (ownerIdFromCaller).
	expect(await getUserPlan(db, { userId: orgId, email })).toBe('pro')
	expect(await getUserPlan(db, { userId: personId, email })).toBe('pro')
	// Mismatched email still fails closed (team org + member email pattern).
	expect(
		await getUserPlan(db, { userId: orgId, email: 'other@example.com' }),
	).toBe('free')
})

test('getUserPlan ignores org billing when email does not match the stable user id', async () => {
	const userId = testStableUserIdFromEmail(plannedEmail)
	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
		orgs: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
	})
	expect(
		await getUserPlan(db, {
			userId,
			email: 'attacker@example.com',
		}),
	).toBe('free')
	expect(await getUserPlan(db, { userId, email: plannedEmail })).toBe('max')
})

test('getUserPlan resolves team org plans with blank email; member email alone stays free', async () => {
	const memberEmail = 'teammate@example.com'
	const memberId = testStableUserIdFromEmail(memberEmail)
	const teamOrgId = 'b'.repeat(64)
	const { db } = createEntitlementsTestDb({
		users: [{ email: memberEmail, plan: 'free', stable_user_id: memberId }],
		orgs: [
			{
				email: 'billing@acme.example',
				plan: 'max',
				stable_user_id: teamOrgId,
			},
		],
	})
	// Actor email + team OwnerId must not inherit the team plan: email path
	// matches only the caller's person id or personal org id.
	expect(await getUserPlan(db, { userId: teamOrgId, email: memberEmail })).toBe(
		'free',
	)
	for (const email of [null, undefined, '', '   ']) {
		expect(await getUserPlan(db, { userId: teamOrgId, email })).toBe('max')
	}
})

test('getCachedUserPlan caches per db binding and never caches failures', async () => {
	const { userId, users, db, queries } = await createPlannedUserDb('pro')
	const context = { userId, email: plannedEmail }

	expect(await getCachedUserPlan(db, context)).toBe('pro')
	expect(await getCachedUserPlan(db, context)).toBe('pro')
	expect(
		queries.filter(
			(query) =>
				/email = \?[\s\S]*stable_user_id = \? OR (?:u\.)?personal_org_id = \?/.test(
					query.sql,
				) && !query.sql.includes('SELECT 1 AS present'),
		),
	).toHaveLength(1)

	// A plan change is visible to the uncached lookup immediately and to the
	// cached lookup only after the TTL: quota checks tolerate that staleness.
	users[0]!.plan = 'free'
	expect(await getUserPlan(db, context)).toBe('free')
	expect(await getCachedUserPlan(db, context)).toBe('pro')

	// Another db binding (fresh test database) never shares cache entries.
	const second = await createPlannedUserDb('free')
	expect(await getCachedUserPlan(second.db, context)).toBe('free')

	// Blank-email background contexts use their own cache entry and resolve by
	// stable id. Invalid ids still short-circuit without touching D1.
	expect(await getCachedUserPlan(db, { userId, email: null })).toBe('free')
	expect(
		await getCachedUserPlan(db, {
			userId: ownerIdFromStored('user-1'),
			email: plannedEmail,
		}),
	).toBe('free')

	// Failures are not pinned for the TTL: the next call retries D1.
	let firstCall = true
	const flaky = {
		prepare: () => ({
			bind: () => ({
				async first() {
					if (firstCall) {
						firstCall = false
						throw new Error('D1 blip')
					}
					return {
						org_id: context.userId,
						plan: 'pro',
						stripe_plan: null,
					}
				},
				all: async () => ({ results: [] }),
			}),
		}),
	} as unknown as D1Database
	await expect(getCachedUserPlan(flaky, context)).rejects.toThrow('D1 blip')
	expect(await getCachedUserPlan(flaky, context)).toBe('pro')
})

test('findCachedUserAccountByStableUserId caches the account reverse-resolution per db', async () => {
	const { userId, db, queries } = await createPlannedUserDb('pro')
	const account = { email: plannedEmail, plan: 'pro', emailVerified: false }
	expect(await findCachedUserAccountByStableUserId(db, userId)).toEqual(account)
	expect(await findCachedUserAccountByStableUserId(db, userId)).toEqual(account)
	expect(
		queries.filter((query) =>
			query.sql.includes('u.email, o.plan, u.email_verified_at'),
		),
	).toHaveLength(1)
	expect(await findCachedUserAccountByStableUserId(db, '  ')).toBeNull()
})

test('assertWithinEntitlement passes under the limit, throws at it, and enforces finite max ordinary limits', async () => {
	const missingReader = await createPlannedUserDb('free')
	await expect(
		assertWithinEntitlement({
			db: missingReader.db,
			userId: ownerIdFromStored(missingReader.userId),
			email: plannedEmail,
			resource: 'scheduled_jobs',
		}),
	).rejects.toThrow(
		'scheduled_jobs usage must be read from jobsData (pass getCurrent or use readCurrentEntitlementResourceUsage).',
	)
	expect(
		missingReader.queries.some((query) => query.sql.includes('FROM jobs')),
	).toBe(false)

	for (const plan of ['max', 'free'] as const) {
		const limit = planLimits[plan].maxScheduledJobs
		const { db, userId } = await createPlannedUserDb(plan)
		const check = (current: number) =>
			assertWithinEntitlement({
				db,
				userId: ownerIdFromStored(userId),
				email: plannedEmail,
				resource: 'scheduled_jobs',
				getCurrent: async () => current,
			})
		await check(limit - 1)
		const error = await expectLimitError(check(limit))
		expect(error.details).toEqual({
			code: 'entitlement_limit_exceeded',
			resource: 'scheduled_jobs',
			plan,
			limit,
			current: limit,
			upgradeHint: error.details.upgradeHint,
		})
		expect(error.message).toBe(buildEntitlementLimitMessage(error.details))
	}
})

test('assertWithinEntitlement reuses cached plan within TTL while still enforcing usage', async () => {
	const freeLimit = planLimits.free.maxScheduledJobs
	const { db, userId, queries } = await createPlannedUserDb('free')
	let current = freeLimit - 1
	let usageReads = 0
	const check = () =>
		assertWithinEntitlement({
			db,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			resource: 'scheduled_jobs',
			getCurrent: async () => {
				usageReads += 1
				return current
			},
		})
	const planQueries = () =>
		queries.filter(
			(query) =>
				/email = \?[\s\S]*stable_user_id = \? OR (?:u\.)?personal_org_id = \?/.test(
					query.sql,
				) && !query.sql.includes('SELECT 1 AS present'),
		)

	await check()
	await check()
	expect(planQueries()).toHaveLength(1)
	expect(usageReads).toBe(2)

	current = freeLimit
	expect((await expectLimitError(check())).details).toMatchObject({
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})
	expect(planQueries()).toHaveLength(1)
	expect(usageReads).toBe(3)
})

test('assertWithinEntitlement enforces concurrent workflow limits for unresolved and max-plan callers', async () => {
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const maxLimit = planLimits.max.maxConcurrentWorkflows
	// concurrent_workflows occupancy is RunLog-backed; create path passes
	// getCurrent from reserveWorkflowProjectionSlot.
	const freeDenial = await expectLimitError(
		assertWithinEntitlement({
			db: createEntitlementsTestDb().db,
			userId: ownerIdFromStored('user-1'),
			email: null,
			resource: 'concurrent_workflows',
			getCurrent: async () => freeLimit,
		}),
	)
	expect(freeDenial.details).toMatchObject({
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})

	const { db, userId } = await createPlannedUserDb('max')
	await assertWithinEntitlement({
		db,
		userId: ownerIdFromStored(userId),
		email: '',
		resource: 'concurrent_workflows',
		getCurrent: async () => freeLimit,
	})
	const maxDenial = await expectLimitError(
		assertWithinEntitlement({
			db: (await createPlannedUserDb('max')).db,
			userId: ownerIdFromStored(userId),
			email: null,
			resource: 'concurrent_workflows',
			getCurrent: async () => maxLimit,
		}),
	)
	expect(maxDenial.details).toMatchObject({
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})

test('plan user daily entitlements increment, enforce at limit, and reset on a new UTC day', async () => {
	const now = new Date('2026-07-05T15:00:00.000Z')
	const nextDay = new Date('2026-07-06T00:00:01.000Z')
	const { db, userId } = await createPlannedUserDb('free')
	const { env } = createInMemoryUserMeterEnv()
	expect(utcDayKey(now)).toBe('2026-07-05')
	const resource = 'email_sends_per_day'
	const consume = (at: Date) =>
		consumeDailyEntitlement({
			db,
			env,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			resource,
			now: at,
		})

	const limit = planLimits.free.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric email send limit.')
	for (let index = 0; index < limit; index += 1) await consume(now)
	expect(await readMeterDailyCount(env, userId, resource, now)).toBe(limit)
	await expect(
		assertWithinEntitlement({
			db,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			resource,
			now,
		}),
	).rejects.toThrow(/must be read from UserMeter/)

	expect((await expectLimitError(consume(now))).details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource,
		plan: 'free',
		limit,
		current: limit,
	})

	await consume(nextDay)
	expect(await readMeterDailyCount(env, userId, resource, nextDay)).toBe(1)
	expect(await readMeterDailyCount(env, userId, resource, now)).toBe(limit)
})

test('public execute and outbound enforce daily and weekly windows; legacy and max stay daily-only', async () => {
	const freeEmail = 'weekly-free@example.com'
	const legacyEmail = 'weekly-legacy@example.com'
	const maxEmail = 'weekly-max@example.com'
	const dailyEmail = 'daily-first@example.com'
	const freeUserId = testStableUserIdFromEmail(freeEmail)
	const legacyUserId = testStableUserIdFromEmail(legacyEmail)
	const maxUserId = testStableUserIdFromEmail(maxEmail)
	const dailyUserId = testStableUserIdFromEmail(dailyEmail)
	const { db } = createEntitlementsTestDb({
		users: [
			{ email: freeEmail, plan: 'free', stable_user_id: freeUserId },
			{
				email: legacyEmail,
				plan: 'free',
				stripe_plan: 'standard',
				entitlement_ladder: 'legacy',
				stable_user_id: legacyUserId,
			},
			{ email: maxEmail, plan: 'max', stable_user_id: maxUserId },
			{ email: dailyEmail, plan: 'free', stable_user_id: dailyUserId },
		],
	})
	const meter = createInMemoryUserMeterEnv()
	const monday = new Date('2026-07-06T15:00:00.000Z')
	const tuesday = new Date('2026-07-07T15:00:00.000Z')
	const wednesday = new Date('2026-07-08T15:00:00.000Z')
	const seed = (
		userId: string,
		resource: DailyEntitlementResource,
		day: Date,
		count: number,
	) => meter.seed({ userId, resource, day: utcDayKey(day), count })
	let workerSeq = 0
	const consume = async (
		userId: string,
		email: string,
		resource: DailyEntitlementResource,
	) => {
		const input = {
			db,
			env: meter.env,
			userId: ownerIdFromStored(userId),
			email,
			now: wednesday,
		}
		if (resource === 'execute_unique_workers_per_day') {
			workerSeq += 1
			await consumeExecuteUniqueWorkerDay({
				...input,
				workerId: `kody-weekly-${workerSeq}`,
			})
			return
		}
		await consumeDailyEntitlement({ ...input, resource })
	}
	const count = (userId: string, resource: DailyEntitlementResource) =>
		readMeterDailyCount(meter.env, userId, resource, wednesday)

	await seed(freeUserId, 'execute_unique_workers_per_day', monday, 150)
	await seed(freeUserId, 'execute_unique_workers_per_day', tuesday, 150)
	await seed(freeUserId, 'execute_unique_workers_per_day', wednesday, 99)
	await consume(freeUserId, freeEmail, 'execute_unique_workers_per_day')
	expect(await count(freeUserId, 'execute_unique_workers_per_day')).toBe(100)
	const weeklyDenied = await expectLimitError(
		consume(freeUserId, freeEmail, 'execute_unique_workers_per_day'),
	)
	expect(weeklyDenied.details).toMatchObject({
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
		limit: 400,
		current: 400,
		window: 'week',
	})
	expect(weeklyDenied.message).toContain('unique execute workers this week')

	await seed(dailyUserId, 'outbound_fetches_per_day', wednesday, 1_000)
	const dailyDenied = await expectLimitError(
		consume(dailyUserId, dailyEmail, 'outbound_fetches_per_day'),
	)
	expect(dailyDenied.details).toMatchObject({
		resource: 'outbound_fetches_per_day',
		plan: 'free',
		limit: 1_000,
		current: 1_000,
	})
	expect(dailyDenied.details.window).toBeUndefined()

	await seed(legacyUserId, 'execute_unique_workers_per_day', monday, 400)
	await consume(legacyUserId, legacyEmail, 'execute_unique_workers_per_day')
	expect(await count(legacyUserId, 'execute_unique_workers_per_day')).toBe(1)

	await seed(maxUserId, 'outbound_fetches_per_day', monday, 10_000)
	await consume(maxUserId, maxEmail, 'outbound_fetches_per_day')
	expect(await count(maxUserId, 'outbound_fetches_per_day')).toBe(1)
})

test('refundDailyEntitlement decrements the user/day counter and floors at zero', async () => {
	const { db } = createEntitlementsTestDb()
	const { env } = createInMemoryUserMeterEnv()
	const now = new Date('2026-07-05T15:00:00.000Z')
	const resource = 'email_receives_per_day'
	for (const [userId, times] of [
		['user-1', 2],
		['user-2', 3],
	] as const) {
		for (let index = 0; index < times; index += 1) {
			await consumeDailyEntitlement({
				db,
				env,
				userId: ownerIdFromStored(userId),
				email: null,
				resource,
				now,
			})
		}
	}
	const refund = () =>
		refundDailyEntitlement({
			env,
			userId: ownerIdFromStored('user-1'),
			resource,
			now,
		})

	await refund()
	expect(await readMeterDailyCount(env, 'user-1', resource, now)).toBe(1)
	expect(await readMeterDailyCount(env, 'user-2', resource, now)).toBe(3)
	await refund()
	await refund()
	expect(await readMeterDailyCount(env, 'user-1', resource, now)).toBe(0)
})

test('missing-email lookups fail closed and honor free email caps', async () => {
	const { db } = createEntitlementsTestDb()
	const { env } = createInMemoryUserMeterEnv()
	const now = new Date('2026-07-05T15:00:00.000Z')
	for (const [resource, limit] of [
		['email_sends_per_day', planLimits.free.maxEmailSendsPerDay],
		['email_receives_per_day', planLimits.free.maxEmailReceivesPerDay],
	] as const) {
		const consume = () =>
			consumeDailyEntitlement({
				db,
				env,
				userId: ownerIdFromStored('user-1'),
				email: null,
				resource,
				now,
			})
		for (let index = 0; index < limit; index += 1) await consume()
		expect(await readMeterDailyCount(env, 'user-1', resource, now)).toBe(limit)
		expect((await expectLimitError(consume())).details).toMatchObject({
			code: 'entitlement_limit_exceeded',
			resource,
			plan: 'free',
			limit,
			current: limit,
		})
	}
})

test('requested units and getCurrent overrides are honored', async () => {
	const { db, userId } = await createPlannedUserDb('standard')
	const maxBytes = planLimits.standard.maxEmailMessageBytes
	if (maxBytes === null) throw new Error('Expected a numeric size cap.')
	const check = (
		resource: 'email_message_bytes' | 'saved_packages',
		requested: number,
		current: number,
	) =>
		assertWithinEntitlement({
			db,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			resource,
			requested,
			getCurrent: async () => current,
		})

	expect(
		(await expectLimitError(check('email_message_bytes', 0, maxBytes + 1)))
			.details,
	).toMatchObject({ resource: 'email_message_bytes', limit: maxBytes })
	await check('email_message_bytes', 0, maxBytes)
	await expect(
		assertWithinEntitlement({
			db,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			resource: 'email_message_bytes',
		}),
	).rejects.toThrow('pass getCurrent')

	const savedPackageLimit = planLimits.standard.maxSavedPackages
	const nearLimit = savedPackageLimit - 3
	expect(
		(await expectLimitError(check('saved_packages', 5, nearLimit))).details,
	).toMatchObject({
		resource: 'saved_packages',
		limit: savedPackageLimit,
		current: nearLimit,
	})
	await check('saved_packages', 3, nearLimit)
})

test('storage bytes enforce for planned users and enforce finite max storage caps', async () => {
	for (const plan of ['max', 'pro'] as const) {
		const limit = planLimits[plan].maxStorageBytes
		const { db, userId } = await createPlannedUserDb(plan)
		const { env } = createInMemoryUserMeterEnv()
		await initializeStorageBytes(env, userId, limit)
		const denied = await expectLimitError(
			assertWithinStorageBytesEntitlement({
				db,
				userId: ownerIdFromStored(userId),
				email: plannedEmail,
				requested: 1,
				env,
			}),
		)
		expect(denied.details).toMatchObject({
			code: 'entitlement_limit_exceeded',
			resource: 'storage_bytes',
			plan,
			limit,
			current: limit,
		})
	}

	// Under limit: reserve succeeds without any D1 write or payload SUM scan.
	const { db, userId, queries } = await createPlannedUserDb('pro')
	const { env } = createInMemoryUserMeterEnv()
	await initializeStorageBytes(env, userId, planLimits.pro.maxStorageBytes - 1)
	await assertWithinStorageBytesEntitlement({
		db,
		userId: ownerIdFromStored(userId),
		email: plannedEmail,
		requested: 1,
		env,
	})
	expect(queries.some(({ sql }) => sql.includes('SUM('))).toBe(false)
})

test('storage byte reserve cold-bootstraps from physical bytes, converges concurrent bootstraps, and denies over-limit', async () => {
	const proLimit = planLimits.pro.maxStorageBytes
	const { db, userId } = await createPlannedUserDb('pro')
	const reserve = (env: MeterEnv | undefined, requested: number) =>
		assertWithinStorageBytesEntitlement({
			db,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			requested,
			env,
		})

	// Cold bootstrap seeds from physical (0 in this fixture); reserve lands
	// on top: 0 + 5.
	const cold = createInMemoryUserMeterEnv().env
	await reserve(cold, 5)
	expect(
		await userMeterRpc({
			env: cold,
			userId: ownerIdFromStored(userId),
		}).readStorageBytes(),
	).toMatchObject({ outcome: 'ready', bytes: 5 })

	// Concurrent cold callers share one lazy reconcile enqueue, then both
	// reserves land: 0 + 5 + 5.
	const concurrent = createInMemoryUserMeterEnv().env
	await Promise.all([reserve(concurrent, 5), reserve(concurrent, 5)])
	expect(
		await userMeterRpc({
			env: concurrent,
			userId: ownerIdFromStored(userId),
		}).readStorageBytes(),
	).toMatchObject({ outcome: 'ready', bytes: 10 })

	const denied = await expectLimitError(
		reserve(createInMemoryUserMeterEnv().env, proLimit + 1),
	)
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		plan: 'pro',
		limit: proLimit,
		current: 0,
	})

	await expect(reserve(undefined, 1)).rejects.toThrow(
		'assertWithinStorageBytesEntitlement requires env.USER_METER',
	)
})

test('storage byte reserve cold-bootstraps existing payload before reserving', async () => {
	const existingBytes = 1_200
	const userId = testStableUserIdFromEmail(plannedEmail)
	// Force the mock SUM path to report existing D1 payload for mcp_memories.
	const withPayload = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
			},
		],
		counts: { mcp_memories: existingBytes },
	})
	const { env } = createInMemoryUserMeterEnv()
	await assertWithinStorageBytesEntitlement({
		db: withPayload.db,
		userId: ownerIdFromStored(userId),
		email: plannedEmail,
		requested: 50,
		env,
	})
	expect(
		await userMeterRpc({
			env,
			userId: ownerIdFromStored(userId),
		}).readStorageBytes(),
	).toMatchObject({ outcome: 'ready', bytes: existingBytes + 50 })
	expect(withPayload.queries.some(({ sql }) => sql.includes('SUM('))).toBe(true)
})

test('storage byte reserve fails closed when the cold physical scan throws', async () => {
	const userId = testStableUserIdFromEmail(plannedEmail)
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql: query, params })
					return {
						first: async () => {
							if (query.includes('SELECT 1 AS present FROM users')) {
								return { present: 1 }
							}
							if (query.includes('SUM(')) {
								throw new Error('injected physical scan failure')
							}
							if (query.includes('FROM orgs') || query.includes('FROM users')) {
								return {
									org_id: userId,
									plan: 'pro',
									stripe_plan: null,
									entitlement_ladder: 'public',
									second_agent_standard_gift_expires_at: null,
									referral_standard_credit_expires_at: null,
								}
							}
							if (query.includes('FROM credit_wallets')) return null
							if (query.includes('FROM org_user_budgets')) return null
							if (isLiveSeatCountQuery(query)) return mockLiveSeatCountRow()
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all() {
							return { results: [] }
						},
						async run() {
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const { env } = createInMemoryUserMeterEnv()
	await expect(
		assertWithinStorageBytesEntitlement({
			db,
			userId: ownerIdFromStored(userId),
			email: plannedEmail,
			requested: 50,
			env,
		}),
	).rejects.toThrow('injected physical scan failure')
	expect(
		await userMeterRpc({
			env,
			userId: ownerIdFromStored(userId),
		}).readStorageBytes(),
	).toEqual({ outcome: 'needs_bootstrap' })
	expect(queries.some(({ sql }) => sql.includes('SUM('))).toBe(true)
})

test('storage byte reserve handles missing user (synthetic context) with free-plan semantics', async () => {
	// A userId with no D1 row must apply free-plan allow/deny without creating
	// a UserMeter storage row for a non-existent account.
	const syntheticUserId = 'a'.repeat(64)
	const reserve = (env: MeterEnv, requested: number) =>
		assertWithinStorageBytesEntitlement({
			db: createEntitlementsTestDb({ users: [] }).db,
			userId: ownerIdFromStored(syntheticUserId),
			email: null,
			requested,
			env,
		})

	const { env } = createInMemoryUserMeterEnv()
	await reserve(env, 1)
	expect(
		await userMeterRpc({
			env,
			userId: ownerIdFromStored(syntheticUserId),
		}).readStorageBytes(),
	).toEqual({ outcome: 'needs_bootstrap' })

	const denied = await expectLimitError(
		reserve(
			createInMemoryUserMeterEnv().env,
			planLimits.free.maxStorageBytes + 1,
		),
	)
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		plan: 'free',
	})
})

test('readCurrentEntitlementResourceUsage for storage_bytes reads UserMeter with cold bootstrap, and never materializes missing users', async () => {
	const { db, userId } = await createPlannedUserDb('pro')
	const { env } = createInMemoryUserMeterEnv()
	const meterEnv: UserMeterEnv = env
	const usageEnv = meterEnv as EntitlementUsageEnv
	const now = new Date()
	const read = (readDb: D1Database, readUserId: string) =>
		readCurrentEntitlementResourceUsage({
			db: readDb,
			env: usageEnv,
			userId: ownerIdFromStored(readUserId),
			resource: 'storage_bytes',
			now,
		})

	// Cold owner with no fixture payload seeds to physical 0.
	expect(await read(db, userId)).toBe(0)
	await userMeterStub(env, userId).setStorageBytes({
		bytes: 750,
		updatedAt: now.toISOString(),
	})
	expect(await read(db, userId)).toBe(750)

	const payloadUserId = testStableUserIdFromEmail('payload-read@example.com')
	const payloadDb = createEntitlementsTestDb({
		users: [
			{
				email: 'payload-read@example.com',
				plan: 'pro',
				stable_user_id: payloadUserId,
			},
		],
		counts: { mcp_memories: 2_500 },
	}).db
	const payloadUsageEnv = createInMemoryUserMeterEnv()
		.env as unknown as EntitlementUsageEnv
	expect(
		await readCurrentEntitlementResourceUsage({
			db: payloadDb,
			env: payloadUsageEnv,
			userId: ownerIdFromStored(payloadUserId),
			resource: 'storage_bytes',
			now,
		}),
	).toBe(2_500)

	const missingUserId = testStableUserIdFromEmail('missing@example.com')
	expect(
		await read(createEntitlementsTestDb({ users: [] }).db, missingUserId),
	).toBe(0)
	await expect(
		userMeterRpc({
			env,
			userId: ownerIdFromStored(missingUserId),
		}).readStorageBytes(),
	).resolves.toEqual({ outcome: 'needs_bootstrap' })
})

test('entitlement enforcement stops when a stored plan violates the schema contract', async () => {
	for (const [index, plan] of [
		null,
		'enterprise-2099',
		'unlimited',
	].entries()) {
		const email = `invalid-stored-plan-${index}@example.com`
		const userId = testStableUserIdFromEmail(email)
		const { db, queries } = createEntitlementsTestDb({
			users: [{ email, plan, stable_user_id: userId }],
			counts: { jobs: planLimits.max.maxScheduledJobs },
		})
		await expect(
			assertWithinEntitlement({
				db,
				userId: ownerIdFromStored(userId),
				email,
				resource: 'scheduled_jobs',
			}),
		).rejects.toThrow('Stored plan is not a registered plan name.')
		expect(queries.some((query) => query.sql.includes('FROM jobs'))).toBe(false)
	}
})

test('getUserPlan resolves effective plan from manual plan and stripe_plan', async () => {
	const cases = [
		['free', { stripe_plan: 'standard' }, 'standard'],
		['standard', { stripe_plan: 'pro' }, 'pro'],
		['max', { stripe_plan: 'pro' }, 'max'],
		[
			'free',
			{ second_agent_standard_gift_expires_at: '2099-01-01T00:00:00.000Z' },
			'pro',
		],
	] as const
	const users: Array<TestUser> = []
	for (const [index, [plan, extra]] of cases.entries()) {
		const email = `effective-plan-${index}@example.com`
		const stable_user_id = testStableUserIdFromEmail(email)
		users.push({ email, plan, stable_user_id, ...extra })
	}
	const { db } = createEntitlementsTestDb({ users })
	const resolved = []
	for (const user of users) {
		resolved.push(
			await getUserPlan(db, { userId: user.stable_user_id, email: user.email }),
		)
	}
	expect(resolved).toEqual(cases.map(([, , expected]) => expected))

	expect(
		['standard', 'pro', 'partner', 'max'].map((name) =>
			parseStripePlanName(name),
		),
	).toEqual(['standard', 'pro', null, null])
})

test('continuous legacy Standard keeps old execute ceiling; new and resubscribed get the public cap', async () => {
	const [legacy, publicUser, resub] = await Promise.all(
		(['legacy', 'public', 'resub'] as const).map(
			async (name): Promise<TestUser> => {
				const email = `${name}-standard@example.com`
				return {
					email,
					plan: 'free',
					stripe_plan: 'standard',
					entitlement_ladder: name === 'legacy' ? 'legacy' : 'public',
					stable_user_id: testStableUserIdFromEmail(email),
				}
			},
		),
	)
	const { db } = createEntitlementsTestDb({
		users: [legacy!, publicUser!, resub!],
	})
	const context = (user: TestUser) => ({
		userId: ownerIdFromStored(user.stable_user_id),
		email: user.email,
	})
	const check = (user: TestUser, requested: number, current: number) =>
		assertWithinEntitlement({
			db,
			...context(user),
			resource: 'execute_unique_workers_per_day',
			requested,
			getCurrent: async () => current,
		})

	expect(await getUserEntitlement(db, context(legacy!))).toEqual({
		plan: 'standard',
		ladder: 'legacy',
		creditWallet: 'none',
		seats: 1,
		limitOverrides: [],
	})
	expect(await getCachedUserEntitlement(db, context(publicUser!))).toEqual({
		plan: 'standard',
		ladder: 'public',
		creditWallet: 'none',
		seats: 1,
		limitOverrides: [],
	})

	const legacyLimit = legacyPlanLimits.standard.maxExecuteUniqueWorkersPerDay
	const publicLimit = planLimits.standard.maxExecuteUniqueWorkersPerDay
	await expect(check(legacy!, 0, publicLimit)).resolves.toBeUndefined()
	await expect(check(publicUser!, 1, publicLimit)).rejects.toMatchObject({
		details: {
			code: 'entitlement_limit_exceeded',
			plan: 'standard',
			limit: publicLimit,
			current: publicLimit,
		},
	})
	await expect(check(resub!, 1, publicLimit)).rejects.toMatchObject({
		details: { limit: publicLimit },
	})
	await expect(check(legacy!, 1, legacyLimit)).rejects.toMatchObject({
		details: { limit: legacyLimit },
	})
})

test('legacy Pro and manual Pro grants keep pre-cut scheduled-job ceilings', async () => {
	const users: Array<TestUser> = []
	for (const [email, plan, stripe_plan] of [
		['legacy-stripe-pro@example.com', 'free', 'pro'],
		['legacy-manual-pro@example.com', 'pro', null],
	] as const) {
		users.push({
			email,
			plan,
			stripe_plan,
			entitlement_ladder: 'legacy',
			stable_user_id: testStableUserIdFromEmail(email),
		})
	}
	const { db } = createEntitlementsTestDb({ users })
	const legacyLimit = legacyPlanLimits.pro.maxScheduledJobs
	const publicLimit = planLimits.pro.maxScheduledJobs
	expect(legacyLimit).toBeGreaterThan(publicLimit)

	for (const user of users) {
		const check = (current: number) =>
			assertWithinEntitlement({
				db,
				userId: ownerIdFromStored(user.stable_user_id),
				email: user.email,
				resource: 'scheduled_jobs',
				requested: 1,
				getCurrent: async () => current,
			})
		await expect(check(publicLimit)).resolves.toBeUndefined()
		await expect(check(legacyLimit)).rejects.toMatchObject({
			details: { plan: 'pro', limit: legacyLimit },
		})
	}
})

test('org budget limit messages match spec and round-trip', () => {
	const user = new BudgetLimitError({
		kind: 'user',
		orgSlug: 'acme',
		actorUsername: 'sam',
		spentMicroUsd: 50_000_000,
		budgetMicroUsd: 50_000_000,
	})
	expect(user.message).toBe(
		'@sam reached their monthly budget in org @acme ($50.00 of $50.00). An org Owner or Billing member can raise it.',
	)
	expect(parseBudgetLimitMessage(user.message)).toEqual(user.details)

	const automation = new BudgetLimitError({
		kind: 'automation',
		orgSlug: 'acme',
		spentMicroUsd: 10_000_000,
		budgetMicroUsd: 10_000_000,
	})
	expect(automation.message).toBe(
		'Automation in org @acme reached its monthly budget. An org Owner or Billing member can raise it.',
	)
	expect(parseBudgetLimitMessage(automation.message)?.kind).toBe('automation')
	expect(buildBudgetLimitMessage(user.details)).toBe(user.message)
})

test('past-include stop message leads with credits, reads in customer units, and round-trips', () => {
	const workerCompute = new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'pro',
		limit: 350,
		current: 412,
		creditsStatus: 'add_credits',
	})
	expect(workerCompute.message).toMatch(
		/^Worker compute include used up: your "pro" plan includes 350 worker-compute days this UTC month and you have used 412\. With no credits left, usage past the include stops\. Add credits at \/account\/usage#credits to keep going; usage past the include is charged at \$0\.004 per worker-compute day\. Keep package code stable/,
	)
	expect(parseComputeOverageLimitMessage(workerCompute.message)).toEqual(
		workerCompute.details,
	)

	const rowsRead = new ComputeOverageLimitError({
		resource: 'durable_object_rows_read',
		plan: 'pro',
		limit: 5_000_000_000,
		current: 5_000_000_001,
		creditsStatus: 'add_credits',
	})
	expect(rowsRead.message).toContain(
		'Rows read include used up: your "pro" plan includes 5,000,000,000 rows read this UTC month and you have used 5,000,000,001.',
	)
	expect(parseComputeOverageLimitMessage(rowsRead.message)).toEqual(
		rowsRead.details,
	)
	expect(parseComputeOverageLimitMessage('Plan limit reached: nope')).toBeNull()
})
