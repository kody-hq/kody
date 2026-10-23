import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { type UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	grantAdminCreditsToUser,
	loadAdminCreditWallet,
	setAdminCreditEligibility,
} from '#worker/admin/credit-grants.ts'
import { updateAdminUserPlan } from '#worker/admin/users-data.ts'
import { ensureRbacTestSchema } from '#worker/test-support/workers-seed.ts'
import {
	assertWithinComputeInclude,
	consumeDailyEntitlement,
	consumeExecuteUniqueWorkerDay,
	getUserEntitlement,
	readDailyEntitlementResourceUsage,
	readExecuteUniqueWorkerUsage,
	resolveBaseUserEntitlement,
} from '#worker/entitlements/service.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { resolvePlanLimit } from '#universal/plans.ts'
import {
	microUsdPerCent,
	signupWelcomeCreditCents,
	signupWelcomeCreditLedgerId,
} from '#universal/credits.ts'
import { loadAccountCreditsUser } from '#app/account-credits-data.ts'
import { runCreditAutoRefill } from './credit-auto-refill.ts'
import { runCreditDebits, settleCreditDebitMonth } from './credit-debits.ts'
import {
	applyCreditPayment,
	ensureCreditWallet,
	readCreditWallet,
	updateCreditWalletSettings,
} from './credit-wallet.ts'
import { grantSignupWelcomeCredits } from './signup-welcome-credits.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const now = new Date('2026-09-27T12:00:00.000Z')
const month = utcMonthKey(now)

type SeededUser = { email: string; stableUserId: string }
type DailyResource = Parameters<typeof consumeDailyEntitlement>[0]['resource']
type LimitResource = Parameters<typeof resolvePlanLimit>[1]

async function seedUser(input: {
	label: string
	plan?: string
	stripePlan?: string | null
	creditsEligible?: boolean
	stripeCustomerId?: string | null
}): Promise<SeededUser> {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${input.label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `${input.label}-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: input.plan ?? 'free',
		stripeCustomerId: input.stripeCustomerId ?? null,
		stripePlan: input.stripePlan ?? null,
		stripeCreditsEligible: input.creditsEligible ? 1 : 0,
		createdAt: now.toISOString(),
	})
	return { email, stableUserId }
}

/** Purchasable (credits-eligible) Stripe Pro. */
function seedPro(label: string, stripeCustomerId?: string) {
	return seedUser({
		label,
		stripePlan: 'pro',
		creditsEligible: true,
		stripeCustomerId,
	})
}

async function setRollup(
	userId: string,
	count: number,
	metric:
		| 'dynamic_worker_day'
		| 'durable_object_rows_read' = 'dynamic_worker_day',
	rollupMonth = month,
) {
	await env.APP_DB.prepare(
		`INSERT INTO usage_rollups (user_id, metric, month, event_count)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (user_id, metric, month) DO UPDATE SET event_count = excluded.event_count`,
	)
		.bind(userId, metric, rollupMonth, count)
		.run()
}

function setReferralOverlay(userId: string) {
	return env.APP_DB.prepare(
		`UPDATE orgs SET referral_standard_credit_expires_at = ? WHERE id = ?`,
	)
		.bind('2099-01-01T00:00:00.000Z', userId)
		.run()
}

function zeroBalance(userId: string) {
	return env.APP_DB.prepare(
		`UPDATE credit_wallets SET balance_micro_usd = 0 WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
}

function entitlementFor(user: SeededUser) {
	return getUserEntitlement(env.APP_DB, {
		userId: user.stableUserId,
		email: user.email,
	})
}

async function limitsFor(user: SeededUser, resources: Array<LimitResource>) {
	const entitlement = await entitlementFor(user)
	return resources.map((resource) =>
		resolvePlanLimit(
			entitlement.plan,
			resource,
			entitlement.ladder,
			entitlement.creditWallet,
			entitlement.seats,
		),
	)
}

/** Adds a live member seat to the org and returns the member's id. */
async function addSeat(org: SeededUser) {
	const member = await seedUser({ label: 'credits-seat' })
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'member', ?)`,
	)
		.bind(org.stableUserId, member.stableUserId, now.toISOString())
		.run()
	return member.stableUserId
}

function removeSeat(org: SeededUser, memberId: string) {
	return env.APP_DB.prepare(
		`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
	)
		.bind(now.toISOString(), org.stableUserId, memberId)
		.run()
}

async function seedThreeSeatPro(label: string) {
	const org = await seedPro(label)
	const members = [await addSeat(org), await addSeat(org)]
	return { org, members }
}

async function balance(userId: string) {
	return (await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd
}

async function ensureWallet(user: SeededUser) {
	await ensureCreditWallet({
		db: env.APP_DB,
		userId: user.stableUserId,
		entitlement: await entitlementFor(user),
		now,
	})
}

function topUp(userId: string, cents: number, reference?: string) {
	return applyCreditPayment({
		db: env.APP_DB,
		userId,
		kind: 'top_up',
		amountCents: cents,
		stripeReference: reference ?? `cs_${crypto.randomUUID()}`,
		paymentMethodId: 'pm_saved',
		now,
	})
}

const debit = () => runCreditDebits({ env, now })

async function consume(user: SeededUser, resource: DailyResource, at = now) {
	const input = {
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(user.stableUserId),
		email: user.email,
		now: at,
	}
	if (resource === 'execute_unique_workers_per_day') {
		await consumeExecuteUniqueWorkerDay({
			...input,
			workerId: `kody-${crypto.randomUUID()}`,
		})
		return
	}
	await consumeDailyEntitlement({ ...input, resource })
}

async function consumeThroughExecuteBoundary(
	user: SeededUser,
	times: number,
	at = now,
) {
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(user.stableUserId)),
		),
	)
	await runInDurableObject(stub, async (instance: UserMeter) => {
		const resource = 'execute_unique_workers_per_day'
		const day = utcDayKey(at)
		await instance.initialize({
			resource,
			day,
			count: 0,
			updatedAt: at.toISOString(),
		})
		for (let index = 0; index < times - 1; index += 1) {
			const claim = await instance.claimDynamicWorkerDayWithinLimit({
				resource,
				day,
				workerId: `fixture-${index}`,
				limit: times,
				createdAt: at.toISOString(),
			})
			expect(claim).toMatchObject({
				outcome: 'ready',
				created: true,
				consumed: true,
			})
		}
	})
	await consume(user, 'execute_unique_workers_per_day', at)
}

function catchError(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(caught: unknown) => caught,
	)
}

async function expectStopped(
	user: SeededUser,
	resource: DailyResource,
	expected: { resource: string; limit: number; current: number },
) {
	const error = await catchError(consume(user, resource))
	expect(isComputeOverageLimitError(error)).toBe(true)
	if (!isComputeOverageLimitError(error)) return
	expect(error.details).toMatchObject({
		code: 'compute_overage_include_reached',
		plan: 'pro',
		creditsStatus: 'add_credits',
		...expected,
	})
	expect(error.message).toContain('/account/usage#credits')
}

const pastIncludeStopped = [
	'execute_unique_workers_per_day',
	'job_runs_per_day',
	'automation_invocations_per_day',
] as const

test('wallet eligibility: only the purchasable Pro gets a wallet; retired plans and Free never unlock', async () => {
	const pro = await seedPro('credits-pro')
	const retiredStandard = await seedUser({
		label: 'credits-retired-standard',
		stripePlan: 'standard',
	})
	const retiredPro = await seedUser({
		label: 'credits-retired-pro',
		stripePlan: 'pro',
	})
	const free = await seedUser({ label: 'credits-free' })
	const manualMax = await seedUser({
		label: 'credits-max',
		plan: 'max',
		stripePlan: 'pro',
		creditsEligible: true,
	})

	for (const user of [pro, retiredStandard, retiredPro, free, manualMax]) {
		await topUp(user.stableUserId, 1_000)
	}

	expect((await entitlementFor(pro)).creditWallet).toBe('funded')
	for (const user of [retiredStandard, retiredPro, free, manualMax]) {
		expect((await entitlementFor(user)).creditWallet).toBe('none')
	}
	expect(
		await limitsFor(retiredPro, ['execute_unique_workers_per_day']),
	).toEqual([1_500])
})

test('credits carry rates past the include up to 50×; stock stays Max; at $0 rates stay on the Pro include', async () => {
	const user = await seedPro('credits-unlock')
	const resources: Array<LimitResource> = [
		'execute_unique_workers_per_day',
		'saved_packages',
		'concurrent_workflows',
		'email_sends_per_day',
	]
	expect((await entitlementFor(user)).creditWallet).toBe('empty')
	// Purchasable Pro includes Max stock even with an empty wallet.
	expect(await limitsFor(user, resources)).toEqual([500, 10_000, 200, 200])

	await ensureWallet(user)
	await topUp(user.stableUserId, 1_000)
	const funded = await entitlementFor(user)
	expect(funded.creditWallet).toBe('funded')
	expect(await limitsFor(user, resources)).toEqual([25_000, 10_000, 200, 200])
	await consume(user, 'execute_unique_workers_per_day')

	// 350 included + 2,500 over at $0.004 = $10.00: balance hits exactly $0.
	await setRollup(user.stableUserId, 350 + 2_500)
	await settleCreditDebitMonth({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(user.stableUserId),
		entitlement: funded,
		month,
		now,
	})
	expect(await balance(user.stableUserId)).toBe(0)
	expect((await entitlementFor(user)).creditWallet).toBe('empty')
	expect(await limitsFor(user, resources)).toEqual([500, 10_000, 200, 200])
})

test('$0 Pro keeps 500 execute/day and stops at 501 with a top-up message; funded runs on; Free is unchanged', async () => {
	const empty = await seedPro('credits-empty-daily')
	expect((await entitlementFor(empty)).creditWallet).toBe('empty')
	await consumeThroughExecuteBoundary(empty, 500)
	const denied = await catchError(
		consume(empty, 'execute_unique_workers_per_day'),
	)
	expect(isEntitlementLimitError(denied)).toBe(true)
	if (!isEntitlementLimitError(denied)) return
	expect(denied.details).toMatchObject({
		resource: 'execute_unique_workers_per_day',
		plan: 'pro',
		limit: 500,
		current: 500,
	})
	expect(denied.message).toContain('add credits')

	const funded = await seedPro('credits-funded-daily')
	await topUp(funded.stableUserId, 1_000)
	await consumeThroughExecuteBoundary(funded, 501)
	expect(
		await readDailyEntitlementResourceUsage({
			env,
			userId: ownerIdFromStored(funded.stableUserId),
			resource: 'execute_unique_workers_per_day',
			now,
		}),
	).toBe(501)

	const free = await seedUser({ label: 'credits-free-daily' })
	await consumeThroughExecuteBoundary(free, 150)
	const freeDenied = await catchError(
		consume(free, 'execute_unique_workers_per_day'),
	)
	expect(isEntitlementLimitError(freeDenied)).toBe(true)
	if (!isEntitlementLimitError(freeDenied)) return
	expect(freeDenied.details).toMatchObject({ plan: 'free', limit: 150 })
	expect(freeDenied.message).not.toContain('add credits')
}, 60_000)

test('a 3-seat Pro org shares one 1,500/day pool; at $0 it keeps the include and stops at 1,501', async () => {
	const { org } = await seedThreeSeatPro('credits-seats-pool')
	const entitlement = await entitlementFor(org)
	expect(entitlement).toMatchObject({ creditWallet: 'empty', seats: 3 })
	expect(
		await limitsFor(org, ['execute_unique_workers_per_day', 'saved_packages']),
	).toEqual([1_500, 10_000])
	expect(
		await readExecuteUniqueWorkerUsage({
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(org.stableUserId),
			email: org.email,
			now,
		}),
	).toMatchObject({ used: 0, limit: 1_500, weekLimit: 3_600 })

	await consumeThroughExecuteBoundary(org, 1_500)
	const denied = await catchError(
		consume(org, 'execute_unique_workers_per_day'),
	)
	expect(isEntitlementLimitError(denied)).toBe(true)
	if (!isEntitlementLimitError(denied)) return
	expect(denied.details).toMatchObject({
		resource: 'execute_unique_workers_per_day',
		plan: 'pro',
		limit: 1_500,
		current: 1_500,
	})
	expect(denied.message).toContain(
		'or add credits at /account/usage#credits to keep going past your include.',
	)
}, 120_000)

test('removing a seat shrinks the org pool on the next check', async () => {
	const { org, members } = await seedThreeSeatPro('credits-seats-shrink')
	await consumeThroughExecuteBoundary(org, 1_000)
	// Warm the entitlement cache at 3 seats so the shrink cannot ride a miss.
	expect((await entitlementFor(org)).seats).toBe(3)

	await removeSeat(org, members[0]!)
	const denied = await catchError(
		consume(org, 'execute_unique_workers_per_day'),
	)
	expect(isEntitlementLimitError(denied)).toBe(true)
	if (!isEntitlementLimitError(denied)) return
	expect(denied.details).toMatchObject({ limit: 1_000, current: 1_000 })
}, 120_000)

test('a funded 3-seat Pro org gets 75,000/day: 50× the pooled include, capped at seats × 25,000', async () => {
	const { org } = await seedThreeSeatPro('credits-seats-funded')
	await topUp(org.stableUserId, 1_000)
	expect(await entitlementFor(org)).toMatchObject({
		creditWallet: 'funded',
		seats: 3,
	})
	expect(await limitsFor(org, ['execute_unique_workers_per_day'])).toEqual([
		75_000,
	])
})

test('debits charge only usage above the include, are idempotent, and never back-charge an empty wallet', async () => {
	const user = await seedPro('credits-debit')
	const userId = user.stableUserId
	// Usage above the include before the wallet exists is never charged,
	// including the prior month the lane still settles.
	await setRollup(userId, 400)
	await setRollup(userId, 5_000, 'dynamic_worker_day', '2026-08')
	await ensureWallet(user)
	await topUp(userId, 1_000)

	await debit()
	expect(await balance(userId)).toBe(10_000_000)

	// +100 unique worker days and +10M rows above the include.
	await setRollup(userId, 500)
	await setRollup(
		userId,
		5_000_000_000 + 10_000_000,
		'durable_object_rows_read',
	)
	await debit()
	const expected = 10_000_000 - 100 * 4_000 - 10 * 2_000
	expect(await balance(userId)).toBe(expected)
	await debit()
	expect(await balance(userId)).toBe(expected)
	const debits = await env.APP_DB.prepare(
		`SELECT meter, units, amount_micro_usd FROM credit_ledger_entries
		 WHERE user_id = ? AND kind = 'debit' ORDER BY meter`,
	)
		.bind(userId)
		.all()
	expect(debits.results).toEqual([
		{
			meter: 'durable_object_rows_read',
			units: 10_000_000,
			amount_micro_usd: -20_000,
		},
		{ meter: 'unique_worker_days', units: 100, amount_micro_usd: -400_000 },
	])

	// Drain to $0, then usage while empty is forgiven, not owed.
	await zeroBalance(userId)
	await setRollup(userId, 900)
	await debit()
	expect(await balance(userId)).toBe(0)
	await topUp(userId, 500)
	await debit()
	expect(await balance(userId)).toBe(5_000_000)
	// Empty-wallet progress settled against the same 350 Pro include, so only
	// usage after the top-up is charged.
	await setRollup(userId, 910)
	await debit()
	expect(await balance(userId)).toBe(5_000_000 - 10 * 4_000)
})

test('include → credits → stop: an empty Pro wallet runs free within the include and stops past it', async () => {
	// Within the include (exactly at 350 / 5B): free, and nothing is debited.
	const within = await seedPro('credits-stop-within')
	await setRollup(within.stableUserId, 350)
	await setRollup(
		within.stableUserId,
		5_000_000_000,
		'durable_object_rows_read',
	)
	expect((await entitlementFor(within)).creditWallet).toBe('empty')
	for (const resource of pastIncludeStopped) await consume(within, resource)
	await debit()
	expect(await balance(within.stableUserId)).toBe(0)

	// Past the Worker compute include with $0: new compute stops, and the
	// stopped attempt does not spend daily quota.
	const past = await seedPro('credits-stop-past')
	await setRollup(past.stableUserId, 351)
	for (const resource of pastIncludeStopped) {
		await expectStopped(past, resource, {
			resource: 'unique_worker_days',
			limit: 350,
			current: 351,
		})
		expect(
			await readDailyEntitlementResourceUsage({
				env,
				userId: ownerIdFromStored(past.stableUserId),
				resource,
				now,
			}),
		).toBe(0)
	}
	// Outbound fetches belong to an already admitted run.
	await consume(past, 'outbound_fetches_per_day')
	// Hosted package apps have no daily counter but take the same stop.
	const appStop = await catchError(
		assertWithinComputeInclude({
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(past.stableUserId),
			now,
		}),
	)
	expect(isComputeOverageLimitError(appStop)).toBe(true)
	await assertWithinComputeInclude({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(within.stableUserId),
		now,
	})

	// Rows read past its include stops the same way.
	const rows = await seedPro('credits-stop-rows')
	await setRollup(rows.stableUserId, 5_000_000_001, 'durable_object_rows_read')
	await expectStopped(rows, 'execute_unique_workers_per_day', {
		resource: 'durable_object_rows_read',
		limit: 5_000_000_000,
		current: 5_000_000_001,
	})

	// The stop does not touch Always-Max stock: at $0 purchasable Pro keeps
	// Max stock and concurrency, and the include rates.
	expect((await entitlementFor(past)).creditWallet).toBe('empty')
	const stock = [
		'repos',
		'saved_packages',
		'scheduled_jobs',
		'repo_sessions',
		'secrets',
		'storage_bytes',
		'concurrent_workflows',
	] as const
	expect(
		await limitsFor(past, [...stock, 'execute_unique_workers_per_day']),
	).toEqual([
		...stock.map((resource) => resolvePlanLimit('max', resource)),
		500,
	])
})

test('include → credits → stop: credits pay past the include, and the stop returns when they run out', async () => {
	// Funded and past the include: runs, and the debit lane charges credits.
	const funded = await seedPro('credits-stop-funded')
	await topUp(funded.stableUserId, 1_000)
	await setRollup(funded.stableUserId, 400)
	for (const resource of pastIncludeStopped) await consume(funded, resource)
	await debit()
	// 50 days past the include × $0.004.
	expect(await balance(funded.stableUserId)).toBe(10_000_000 - 50 * 4_000)

	// Credits run out: 250 days past the include × $0.004 = $1.00 → $0.
	const drained = await seedPro('credits-stop-drained')
	await topUp(drained.stableUserId, 100)
	await setRollup(drained.stableUserId, 350 + 250)
	await debit()
	expect(await balance(drained.stableUserId)).toBe(0)
	await expectStopped(drained, 'execute_unique_workers_per_day', {
		resource: 'unique_worker_days',
		limit: 350,
		current: 600,
	})

	// Stopped at $0, then credits are added: runs resume right away (the
	// cached empty wallet is re-checked before stopping), and the stretch
	// before the stop applied is forgiven, not charged.
	const resumed = await seedPro('credits-stop-resumed')
	await setRollup(resumed.stableUserId, 420)
	await expectStopped(resumed, 'execute_unique_workers_per_day', {
		resource: 'unique_worker_days',
		limit: 350,
		current: 420,
	})
	await topUp(resumed.stableUserId, 500)
	await consume(resumed, 'execute_unique_workers_per_day')
	await assertWithinComputeInclude({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(resumed.stableUserId),
		now,
	})
	await debit()
	expect(await balance(resumed.stableUserId)).toBe(5_000_000)
})

test('a top-up past the monthly include applies funded rates right away, not the cached $0 include', async () => {
	const user = await seedPro('credits-stop-topup-rates')
	await consumeThroughExecuteBoundary(user, 500)
	// Expire the 60s entitlement and monthly-usage caches warmed above, so
	// the stop sees the rollup and the cache holds the $0 entitlement.
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(Date.now() + 61_000)
		await setRollup(user.stableUserId, 420)
		await expectStopped(user, 'execute_unique_workers_per_day', {
			resource: 'unique_worker_days',
			limit: 350,
			current: 420,
		})
		await topUp(user.stableUserId, 500)
		await consume(user, 'execute_unique_workers_per_day')
	} finally {
		vi.useRealTimers()
	}
	expect(
		await readDailyEntitlementResourceUsage({
			env,
			userId: ownerIdFromStored(user.stableUserId),
			resource: 'execute_unique_workers_per_day',
			now,
		}),
	).toBe(501)
}, 60_000)

test('plans without a wallet are never stopped past the monthly include, and retired balances are never debited', async () => {
	const walletless = [
		await seedUser({ label: 'credits-stop-free' }),
		await seedUser({
			label: 'credits-stop-retired-standard',
			stripePlan: 'standard',
		}),
		await seedUser({ label: 'credits-stop-retired-pro', stripePlan: 'pro' }),
		await seedUser({ label: 'credits-stop-manual-pro', plan: 'pro' }),
		await seedUser({ label: 'credits-stop-max', plan: 'max' }),
	]
	for (const user of walletless) {
		await setRollup(user.stableUserId, 100_000)
		expect((await entitlementFor(user)).creditWallet).toBe('none')
		for (const resource of pastIncludeStopped) await consume(user, resource)
	}
	// Gift/referral Pro overlays keep retired Pro ceilings without a wallet.
	const gift = await seedUser({ label: 'credits-stop-gift' })
	await setReferralOverlay(gift.stableUserId)
	await setRollup(gift.stableUserId, 100_000)
	expect(await entitlementFor(gift)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		seats: 1,
		limitOverrides: [],
	})
	for (const resource of pastIncludeStopped) await consume(gift, resource)

	const retired = await seedUser({
		label: 'credits-retired-debit',
		stripePlan: 'standard',
	})
	await topUp(retired.stableUserId, 1_000)
	await setRollup(retired.stableUserId, 5_000)
	await debit()
	expect(await balance(retired.stableUserId)).toBe(10_000_000)
})

test('gift overlay usage above credits include is not back-charged on resubscribe', async () => {
	const user = await seedPro('credits-gift-resub')
	const userId = user.stableUserId
	await topUp(userId, 1_000)
	await setRollup(userId, 400)
	await debit()
	// 400 − 350 = 50 billable days × $0.004 = 200_000 µUSD.
	const afterPaid = 10_000_000 - 200_000
	expect(await balance(userId)).toBe(afterPaid)

	// Cancel purchasable Pro while a referral overlay is active.
	await env.APP_DB.prepare(
		`UPDATE orgs
		 SET stripe_plan = NULL, stripe_credits_eligible = 0,
		     referral_standard_credit_expires_at = ?
		 WHERE id = ?`,
	)
		.bind('2099-01-01T00:00:00.000Z', userId)
		.run()
	expect(await entitlementFor(user)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		seats: 1,
		limitOverrides: [],
	})
	await setRollup(userId, 600)
	await debit()
	expect(await balance(userId)).toBe(afterPaid)

	// Resubscribe with the remaining funded balance: gift-period days
	// between 350 and 600 must stay forgiven.
	await env.APP_DB.prepare(
		`UPDATE orgs
		 SET stripe_plan = 'pro', stripe_credits_eligible = 1,
		     referral_standard_credit_expires_at = NULL
		 WHERE id = ?`,
	)
		.bind(userId)
		.run()
	expect(await entitlementFor(user)).toMatchObject({
		plan: 'pro',
		creditWallet: 'funded',
	})
	await debit()
	expect(await balance(userId)).toBe(afterPaid)
})

test('gift overlay with no prior wallet row is not skipped by debit and is not back-charged', async () => {
	const user = await seedUser({ label: 'credits-gift-nowallet' })
	const userId = user.stableUserId
	await setReferralOverlay(userId)
	expect(await entitlementFor(user)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		seats: 1,
		limitOverrides: [],
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT 1 AS present FROM credit_wallets WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toBeNull()

	// Accrue past the purchasable Pro include while walletless.
	await setRollup(userId, 600)
	await debit()

	// Debit backfills a zero-balance row and advances non-charging progress
	// (600 − 350 = 250 UWD) so a later funded return cannot back-charge.
	expect(await balance(userId)).toBe(0)
	const progress = await env.APP_DB.prepare(
		`SELECT accounted_units FROM credit_debit_progress
		 WHERE user_id = ? AND month = ? AND meter = 'unique_worker_days'`,
	)
		.bind(userId, month)
		.first<{ accounted_units: number }>()
	expect(Number(progress?.accounted_units)).toBe(250)

	await env.APP_DB.prepare(
		`UPDATE orgs
		 SET stripe_plan = 'pro', stripe_credits_eligible = 1,
		     referral_standard_credit_expires_at = NULL
		 WHERE id = ?`,
	)
		.bind(userId)
		.run()
	await topUp(userId, 1_000)
	expect(await entitlementFor(user)).toMatchObject({
		plan: 'pro',
		creditWallet: 'funded',
	})
	await debit()
	expect(await balance(userId)).toBe(10_000_000)
})

test('a replayed top-up credits once', async () => {
	const user = await seedPro('credits-replay')
	expect(await topUp(user.stableUserId, 2_500, 'cs_replay')).toEqual({
		applied: true,
		balanceMicroUsd: 25_000_000,
	})
	expect(await topUp(user.stableUserId, 2_500, 'cs_replay')).toEqual({
		applied: false,
		balanceMicroUsd: 25_000_000,
	})
	expect(
		(await readCreditWallet(env.APP_DB, user.stableUserId))
			.autoRefillPaymentMethodId,
	).toBe('pm_saved')
})

test('new accounts get $5 signup welcome credits once, with an honest ledger row', async () => {
	const user = await seedUser({ label: 'signup-welcome' })
	const first = await grantSignupWelcomeCredits({
		db: env.APP_DB,
		userId: user.stableUserId,
		now,
	})
	expect(first).toEqual({
		applied: true,
		entryId: signupWelcomeCreditLedgerId(user.stableUserId),
		balanceMicroUsd: signupWelcomeCreditCents * microUsdPerCent,
		createdAt: now.toISOString(),
	})

	const wallet = await readCreditWallet(env.APP_DB, user.stableUserId)
	expect(wallet.balanceMicroUsd).toBe(5_000_000)

	const row = await env.APP_DB.prepare(
		`SELECT id, kind, amount_micro_usd, granted_by_user_id
		 FROM credit_ledger_entries WHERE user_id = ?`,
	)
		.bind(user.stableUserId)
		.first<{
			id: string
			kind: string
			amount_micro_usd: number
			granted_by_user_id: string | null
		}>()
	expect(row).toEqual({
		id: signupWelcomeCreditLedgerId(user.stableUserId),
		kind: 'admin_grant',
		amount_micro_usd: 5_000_000,
		granted_by_user_id: null,
	})

	const replay = await grantSignupWelcomeCredits({
		db: env.APP_DB,
		userId: user.stableUserId,
		now,
	})
	expect(replay).toEqual({
		applied: false,
		entryId: signupWelcomeCreditLedgerId(user.stableUserId),
		balanceMicroUsd: 5_000_000,
		createdAt: now.toISOString(),
	})
	expect(
		(
			await env.APP_DB.prepare(
				`SELECT COUNT(*) AS count FROM credit_ledger_entries WHERE user_id = ?`,
			)
				.bind(user.stableUserId)
				.first<{ count: number }>()
		)?.count,
	).toBe(1)
})

test('admins can grant credits to any account, including themselves, with an audited ledger row', async () => {
	const admin = await seedPro('credits-admin')
	const customer = await seedUser({ label: 'credits-grantee' })
	const grantedBy = { stableUserId: admin.stableUserId, email: admin.email }

	const self = await grantAdminCreditsToUser({
		env,
		target: { stableUserId: admin.stableUserId },
		grantedBy,
		amountCents: 5_000,
		note: 'Top off owner wallet',
		path: '/admin/users/credits.json',
		now,
	})
	expect(self.wallet).toMatchObject({
		stableUserId: admin.stableUserId,
		eligible: true,
		unlocked: true,
		balanceMicroUsd: 50_000_000,
	})
	expect(self.wallet.recent[0]).toMatchObject({
		kind: 'admin_grant',
		amountMicroUsd: 50_000_000,
		note: 'Top off owner wallet',
		createdAt: now.toISOString(),
	})
	expect(self.wallet.recent[0]?.grantedByUsername).toMatch(/^credits-admin-/)

	const other = await grantAdminCreditsToUser({
		env,
		target: { email: customer.email },
		grantedBy,
		amountCents: 1_000,
		note: undefined,
		path: '/mcp',
		audit: false,
		now,
	})
	expect(other.wallet).toMatchObject({
		eligible: false,
		unlocked: false,
		balanceMicroUsd: 10_000_000,
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT user_id, granted_by_user_id, note, amount_micro_usd
			 FROM credit_ledger_entries WHERE id = ?`,
		)
			.bind(other.entryId)
			.first(),
	).toEqual({
		user_id: customer.stableUserId,
		granted_by_user_id: admin.stableUserId,
		note: null,
		amount_micro_usd: 10_000_000,
	})

	await expect(
		grantAdminCreditsToUser({
			env,
			target: { stableUserId: customer.stableUserId },
			grantedBy,
			amountCents: 0,
			note: null,
			path: '/mcp',
			now,
		}),
	).rejects.toMatchObject({ status: 400 })
	expect(
		(await loadAdminCreditWallet(env, { stableUserId: customer.stableUserId }))
			?.balanceMicroUsd,
	).toBe(10_000_000)
})

test('admin eligibility unlocks a manual Pro wallet without Stripe, survives Stripe refreshes, and clearing it holds the balance', async () => {
	const admin = await seedUser({ label: 'credits-eligibility-admin' })
	const user = await seedUser({ label: 'credits-manual-pro', plan: 'pro' })
	const userId = user.stableUserId
	const executeLimit = async () =>
		(await limitsFor(user, ['execute_unique_workers_per_day']))[0]
	// Usage above the Pro include while the wallet was locked.
	await setRollup(userId, 900)
	const granted = await grantAdminCreditsToUser({
		env,
		target: { stableUserId: userId },
		grantedBy: { stableUserId: admin.stableUserId, email: admin.email },
		amountCents: 100_000,
		note: undefined,
		path: '/mcp',
		audit: false,
		now,
	})
	expect(granted.wallet).toMatchObject({
		plan: 'pro',
		eligible: false,
		adminCreditsEligible: false,
		unlocked: false,
		balanceMicroUsd: 1_000_000_000,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('none')
	// Without a wallet, manual Pro keeps the retired Pro table.
	expect(await executeLimit()).toBe(1_500)

	const enabled = await setAdminCreditEligibility({
		env,
		target: { username: granted.wallet.username },
		creditsEligible: true,
		note: 'Manual Pro wallet',
		now,
	})
	expect(enabled.previousAdminCreditsEligible).toBe(false)
	expect(enabled.note).toBe('Manual Pro wallet')
	expect(enabled.wallet).toMatchObject({
		plan: 'pro',
		eligible: true,
		adminCreditsEligible: true,
		unlocked: true,
		balanceMicroUsd: 1_000_000_000,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('funded')
	expect(await executeLimit()).toBe(25_000)

	// Usage from before eligibility is not charged; new usage is.
	await debit()
	expect(await balance(userId)).toBe(1_000_000_000)
	await setRollup(userId, 1_000)
	await debit()
	expect(await balance(userId)).toBe(1_000_000_000 - 100 * 4_000)

	// A Stripe refresh rewrites only the Stripe projection.
	await env.APP_DB.prepare(
		`UPDATE orgs SET stripe_credits_eligible = 0 WHERE id = ?`,
	)
		.bind(userId)
		.run()
	expect((await entitlementFor(user)).creditWallet).toBe('funded')
	const stripeColumns = await env.APP_DB.prepare(
		`SELECT id, stripe_customer_id, stripe_plan, stripe_price_id
		 FROM orgs WHERE id = ?`,
	)
		.bind(userId)
		.first<{ id: number }>()
	expect(stripeColumns).toMatchObject({
		stripe_customer_id: null,
		stripe_plan: null,
		stripe_price_id: null,
	})
	const account = await env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.first<{ id: number }>()
	// Admin eligibility funds the wallet but never enables buying credits.
	expect(
		(
			await loadAccountCreditsUser({
				env,
				userId: account?.id ?? 0,
				orgId: userId,
				personal: true,
				now,
			})
		)?.canBuyCredits,
	).toBe(false)

	const cleared = await setAdminCreditEligibility({
		env,
		target: { email: user.email },
		creditsEligible: false,
		note: undefined,
		now,
	})
	expect(cleared.previousAdminCreditsEligible).toBe(true)
	expect(cleared.wallet).toMatchObject({
		eligible: false,
		adminCreditsEligible: false,
		unlocked: false,
		balanceMicroUsd: 1_000_000_000 - 100 * 4_000,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('none')
	expect(await executeLimit()).toBe(1_500)
	await setRollup(userId, 2_000)
	await debit()
	expect(await balance(userId)).toBe(1_000_000_000 - 100 * 4_000)
})

test('granting manual Pro after admin eligibility still forgives locked-period usage', async () => {
	const user = await seedUser({ label: 'credits-eligible-then-pro' })
	await ensureRbacTestSchema(env.APP_DB)
	const userId = user.stableUserId
	await topUp(userId, 1_000)
	await setRollup(userId, 900)
	const enabled = await setAdminCreditEligibility({
		env,
		target: { stableUserId: userId },
		creditsEligible: true,
		note: null,
		now,
	})
	expect(enabled.wallet).toMatchObject({
		plan: 'free',
		eligible: false,
		adminCreditsEligible: true,
	})
	await updateAdminUserPlan(env.APP_DB, {
		stableUserId: userId,
		plan: 'pro',
		now,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('funded')
	await debit()
	expect(await balance(userId)).toBe(10_000_000)
	await setRollup(userId, 1_000)
	await debit()
	expect(await balance(userId)).toBe(10_000_000 - 100 * 4_000)
})

test('admin eligibility does not unlock a wallet outside an effective Pro plan', async () => {
	const manualMax = await seedUser({
		label: 'credits-eligible-max',
		plan: 'max',
	})
	const free = await seedUser({ label: 'credits-eligible-free' })
	for (const user of [manualMax, free]) {
		await topUp(user.stableUserId, 1_000)
		const result = await setAdminCreditEligibility({
			env,
			target: { stableUserId: user.stableUserId },
			creditsEligible: true,
			note: null,
			now,
		})
		expect(result.wallet).toMatchObject({
			eligible: false,
			adminCreditsEligible: true,
			unlocked: false,
		})
		expect((await entitlementFor(user)).creditWallet).toBe('none')
	}
	await expect(
		setAdminCreditEligibility({
			env,
			target: { username: `missing-${crypto.randomUUID()}` },
			creditsEligible: true,
			note: null,
			now,
		}),
	).rejects.toMatchObject({ status: 404 })
})

test('auto-refill charges the saved card at the threshold and stops at the monthly cap', async () => {
	const stripeCustomerId = `cus_${crypto.randomUUID().slice(0, 8)}`
	const user = await seedPro('credits-refill', stripeCustomerId)
	const userId = user.stableUserId
	await ensureWallet(user)
	await topUp(userId, 500)
	await zeroBalance(userId)
	await updateCreditWalletSettings({
		db: env.APP_DB,
		userId,
		autoRefill: {
			enabled: true,
			thresholdCents: 500,
			amountCents: 1_000,
			monthlyCapCents: 1_500,
		},
		notify: { autoRefilled: false, monthlyCap: false, lowBalance: false },
		now,
	})
	const stripeEnv = {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
	} as Env
	const fetchMock = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? 'GET'
			const href = String(url)
			if (method === 'GET' && href.includes('/v1/payment_intents')) {
				return Response.json({ data: [], has_more: false })
			}
			return Response.json({
				id: `pi_${crypto.randomUUID().slice(0, 8)}`,
				status: 'succeeded',
				amount: 1_000,
				currency: 'usd',
			})
		},
	)
	const refill = (customerId: string) =>
		runCreditAutoRefill({
			env: stripeEnv,
			userId,
			email: user.email,
			stripeCustomerId: customerId,
			now,
		})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(await refill(stripeCustomerId)).toBe('charged')
		// List reconcile (empty) then create PaymentIntent.
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(await balance(userId)).toBe(10_000_000)

		// Above the threshold: nothing to do.
		expect(await refill('cus_any')).toBe('skipped')

		// Back under the threshold, but another $10 would pass the $15 cap.
		await zeroBalance(userId)
		expect(await refill('cus_any')).toBe('cap_reached')
		expect(fetchMock).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('funding an empty wallet forgives usage from before the top-up', async () => {
	const user = await seedPro('credits-refund-gap')
	const userId = user.stableUserId
	await ensureWallet(user)
	// Usage grows above the include while the wallet is empty, between
	// sweeps; the top-up lands before the next sweep.
	await setRollup(userId, 450)
	await topUp(userId, 1_000)
	await debit()
	expect(await balance(userId)).toBe(10_000_000)
	// Usage after the top-up is debited.
	await setRollup(userId, 460)
	await debit()
	expect(await balance(userId)).toBe(10_000_000 - 10 * 4_000)
})

test('the bounded debit sweep resumes from its cursor and wraps at the tail', async () => {
	const users = [
		await seedPro('credits-cursor-a'),
		await seedPro('credits-cursor-b'),
	]
	const [first, second] = [...users].sort((left, right) =>
		left.stableUserId.localeCompare(right.stableUserId),
	)
	if (!first || !second) throw new Error('Expected two users.')
	for (const user of [first, second]) {
		await ensureWallet(user)
		await topUp(user.stableUserId, 1_000)
		await setRollup(user.stableUserId, 351)
	}
	// A previous bounded run stopped right after `first`.
	await env.APP_DB.prepare(
		`UPDATE credit_debit_cursor SET position = ? WHERE singleton = 1`,
	)
		.bind(first.stableUserId)
		.run()
	await debit()
	expect(await balance(second.stableUserId)).toBe(10_000_000 - 4_000)
	expect(await balance(first.stableUserId)).toBe(10_000_000)
	expect(
		await env.APP_DB.prepare(
			`SELECT position FROM credit_debit_cursor WHERE singleton = 1`,
		).first(),
	).toEqual({ position: '' })
	await debit()
	expect(await balance(first.stableUserId)).toBe(10_000_000 - 4_000)
})

test('gift and referral Pro overlays keep retired Pro ceilings without a wallet', async () => {
	const overlay = await seedUser({
		label: 'credits-overlay',
		stripeCustomerId: `cus_${crypto.randomUUID().slice(0, 8)}`,
	})
	await setReferralOverlay(overlay.stableUserId)
	const paying = await seedPro(
		'credits-paying',
		`cus_${crypto.randomUUID().slice(0, 8)}`,
	)
	const creditsUser = async (stableUserId: string) => {
		const row = await env.APP_DB.prepare(
			`SELECT id FROM users WHERE stable_user_id = ?`,
		)
			.bind(stableUserId)
			.first<{ id: number }>()
		return loadAccountCreditsUser({
			env,
			userId: row?.id ?? 0,
			orgId: stableUserId,
			personal: true,
			now,
		})
	}
	const overlayUser = await creditsUser(overlay.stableUserId)
	expect(overlayUser?.entitlement).toMatchObject({
		plan: 'pro',
		creditWallet: 'none',
	})
	expect(overlayUser?.canBuyCredits).toBe(false)
	const payingUser = await creditsUser(paying.stableUserId)
	expect(payingUser?.canBuyCredits).toBe(true)
	expect(payingUser?.entitlement.creditWallet).toBe('empty')
})

test('saving credit settings before any top-up creates the wallet and keeps the settings', async () => {
	const { stableUserId: userId } = await seedPro('credits-settings-first')
	const autoRefill = {
		enabled: true,
		thresholdCents: 500,
		amountCents: 1_000,
		monthlyCapCents: 5_000,
	}
	const saved = await updateCreditWalletSettings({
		db: env.APP_DB,
		userId,
		autoRefill,
		notify: { autoRefilled: false, monthlyCap: true, lowBalance: true },
		now,
	})
	expect(saved.autoRefill).toEqual(autoRefill)
	expect(saved.notify.autoRefilled).toBe(false)
	await topUp(userId, 1_000)
	const wallet = await readCreditWallet(env.APP_DB, userId)
	expect(wallet.balanceMicroUsd).toBe(10_000_000)
	expect(wallet.autoRefill).toEqual(autoRefill)
})

test('base entitlement never pairs an overlay plan with Stripe-only eligibility', async () => {
	const overlay = await seedUser({ label: 'credits-base-overlay' })
	await setReferralOverlay(overlay.stableUserId)
	await topUp(overlay.stableUserId, 1_000)
	const paying = await seedPro('credits-base-paying')
	await topUp(paying.stableUserId, 1_000)
	const retired = await seedUser({
		label: 'credits-base-retired',
		stripePlan: 'pro',
	})
	const base = async (stableUserId: string) => {
		const row = await env.APP_DB.prepare(
			`SELECT plan, stripe_plan, entitlement_ladder, stripe_credits_eligible
			 FROM orgs WHERE id = ?`,
		)
			.bind(stableUserId)
			.first<{
				plan: string
				stripe_plan: string | null
				entitlement_ladder: string | null
				stripe_credits_eligible: number
			}>()
		if (!row) throw new Error('Expected a user row.')
		return resolveBaseUserEntitlement({ db: env.APP_DB, stableUserId, row })
	}
	// Base plans ignore overlays entirely: Free, no wallet.
	expect(await base(overlay.stableUserId)).toEqual({
		plan: 'free',
		ladder: 'public',
		creditWallet: 'none',
		limitOverrides: [],
	})
	expect(await base(paying.stableUserId)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'funded',
		limitOverrides: [],
	})
	expect(await base(retired.stableUserId)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		limitOverrides: [],
	})
	// Overlay-aware resolution grants Pro without a wallet (retired ceilings).
	expect(await entitlementFor(overlay)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		seats: 1,
		limitOverrides: [],
	})
})
