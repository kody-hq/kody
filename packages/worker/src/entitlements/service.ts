import {
	utcDayKey,
	utcMonthKey,
	utcWeekStart,
} from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { JobsStore } from '@kody-internal/shared/jobs/store.ts'
import { resolvePastIncludeStop } from '#universal/compute-overage.ts'
import {
	isCreditsUnlockedResource,
	isDailyEntitlementResource,
	isLimitOverrideResource,
	isPastIncludeStopResource,
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	resolveCreditWalletState,
	resolveEffectivePlan,
	resolveEntitlementLimit,
	resolveWeeklyEntitlementLimit,
	type DailyEntitlementResource,
	type EntitlementResource,
	type PlanName,
	type UserEntitlement,
} from '#universal/plans.ts'
import { laterIsoTimestamp } from '#universal/referral-program.ts'
import { resolvePlanOverlay } from '#universal/second-agent-standard-gift.ts'
import { countInternalUserEmailMessages } from '#worker/email/mailbox-internal-read.ts'
import { jobsData, type JobsDataEnv } from '#worker/jobs/jobs-data.ts'
import type { RepoSessionIndexEnv } from '#worker/repo/repo-session-index-client.ts'
import { countActiveRepoSessions } from '#worker/repo/repo-sessions.ts'
import { countActiveWorkflowProjections } from '#worker/run-records/service.ts'
import {
	readMonthlyComputeUsage,
	type MonthlyComputeUsage,
} from '#worker/billing/compute-overage-usage.ts'
import {
	ComputeOverageLimitError,
	EntitlementLimitError,
	buildEntitlementUpgradeHint,
	isBudgetLimitError,
} from './errors.ts'
import { orgBillingPath, orgUsagePath } from '#universal/org-pages.ts'
import { countLiveSeats } from '#worker/orgs/billing.ts'
import { joinOrgsOnPersonalOrgIdSql } from '#worker/orgs/personal-org-sql.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import {
	assertWithinOrgBudget,
	orgBudgetFromGateContext,
	type OrgBudgetGateContext,
} from './budget-gate.ts'
import { readActiveOrgLimitOverrides } from './limit-overrides.ts'
import type { UserMeterUsageSnapshotResult } from './user-meter-do.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from './user-meter-client.ts'
import { enqueueOwnerD1StorageReconcile } from './d1-storage-reconciliation.ts'

/** Env surface for authoritative entitlement usage readers. */
import {
	andLiveDeletedAtSql,
	liveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'

export type EntitlementUsageEnv = UserMeterEnv &
	RepoSessionIndexEnv &
	Pick<Env, 'RUN_LOG' | 'MAILBOX' | 'JOBS'>

const stableUserIdPattern = /^[a-f0-9]{64}$/i

const publicFreeEntitlement: UserEntitlement = {
	plan: 'free',
	ladder: 'public',
	creditWallet: 'none',
}

/**
 * Org columns every entitlement resolution reads. Select these (with an
 * `o.` prefix via {@link userEntitlementColumnsSql}) wherever a sweep
 * already has the org row, then call {@link resolveUserEntitlementFromRow}.
 */
export const userEntitlementColumns = [
	'plan',
	'stripe_plan',
	'entitlement_ladder',
	'stripe_credits_eligible',
	'admin_credits_eligible',
	'second_agent_standard_gift_expires_at',
	'referral_standard_credit_expires_at',
] as const

export function userEntitlementColumnsSql(alias?: string) {
	const prefix = alias ? `${alias}.` : ''
	return userEntitlementColumns.map((column) => `${prefix}${column}`).join(', ')
}

export type UserEntitlementRow = {
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	/** Absent on rows selected before the credits migration (fixtures). */
	stripe_credits_eligible?: number | null
	/** Absent on rows selected before the admin eligibility migration (fixtures). */
	admin_credits_eligible?: number | null
	second_agent_standard_gift_expires_at: string | null
	referral_standard_credit_expires_at: string | null
}

/**
 * Stored credit eligibility, independent of the effective plan: the
 * purchasable Pro Stripe price (`stripe_credits_eligible`, rewritten by every
 * Stripe refresh) or an admin decision (`admin_credits_eligible`, never
 * touched by Stripe). Only an effective `pro` plan uses it.
 */
export function hasStoredCreditsEligibility(
	row: Pick<
		UserEntitlementRow,
		'stripe_credits_eligible' | 'admin_credits_eligible'
	>,
): boolean {
	return (
		Number(row.stripe_credits_eligible) === 1 ||
		Number(row.admin_credits_eligible) === 1
	)
}

/**
 * Effective plan, ladder, and credit eligibility for a `users` row, without
 * the wallet balance. Eligible means an effective `pro` with the purchasable
 * Pro Stripe price or admin eligibility ({@link hasStoredCreditsEligibility}).
 * Second-agent / referral Pro overlays raise Free to the retired Pro table
 * without a credit wallet, so they keep pre-credits Pro ceilings. A manual
 * `max` grant outranks all of them.
 */
export function resolveUserPlanFromRow(
	row: UserEntitlementRow,
	now?: Date,
): {
	plan: PlanName
	ladder: UserEntitlement['ladder']
	creditsEligible: boolean
} {
	const { plan } = resolvePlanOverlay(
		parseStoredPlanName(row.plan),
		row.stripe_plan,
		laterIsoTimestamp(
			row.second_agent_standard_gift_expires_at,
			row.referral_standard_credit_expires_at,
		),
		now,
	)
	return {
		plan,
		ladder: parseEntitlementLadder(row.entitlement_ladder),
		creditsEligible: plan === 'pro' && hasStoredCreditsEligibility(row),
	}
}

/**
 * Subscribed on the purchasable Pro Stripe price (not a gift or referral
 * overlay). Only these accounts can buy credits or use auto-refill.
 */
export function isPayingForCreditsPro(row: UserEntitlementRow): boolean {
	return (
		parseStripePlanName(row.stripe_plan) === 'pro' &&
		Number(row.stripe_credits_eligible) === 1
	)
}

/**
 * Read the prepaid credit balance (micro-USD). Missing wallet rows are a
 * zero balance.
 */
export async function readCreditWalletBalanceMicroUsd(
	db: D1Database,
	stableUserId: string,
): Promise<number> {
	const row = await db
		.prepare(`SELECT balance_micro_usd FROM credit_wallets WHERE user_id = ?`)
		.bind(stableUserId)
		.first<{ balance_micro_usd: number }>()
	return Number(row?.balance_micro_usd ?? 0)
}

/**
 * Entitlement from the manual grant and Stripe only, without gift or
 * referral overlays (inbound email scores the base plan so gifted Pro
 * cannot inflate receive caps). It resolves the plan itself so an overlay
 * plan can never be paired with Stripe-only eligibility. Overlay-aware
 * callers (live gating, user warnings, fleet entitlement sweeps) use
 * {@link resolveUserEntitlementFromRow}.
 */
export async function resolveBaseUserEntitlement(input: {
	db: D1Database
	stableUserId: string
	row: Pick<
		UserEntitlementRow,
		| 'plan'
		| 'stripe_plan'
		| 'entitlement_ladder'
		| 'stripe_credits_eligible'
		| 'admin_credits_eligible'
	>
}): Promise<UserEntitlement> {
	const plan = resolveEffectivePlan(
		parseStoredPlanName(input.row.plan),
		input.row.stripe_plan,
	)
	const creditsEligible =
		plan === 'pro' && hasStoredCreditsEligibility(input.row)
	const [balanceMicroUsd, limitOverrides] = await Promise.all([
		creditsEligible
			? readCreditWalletBalanceMicroUsd(input.db, input.stableUserId)
			: null,
		readActiveOrgLimitOverrides(input.db, input.stableUserId),
	])
	return {
		plan,
		ladder: parseEntitlementLadder(input.row.entitlement_ladder),
		creditWallet: creditsEligible
			? resolveCreditWalletState({ plan, creditsEligible, balanceMicroUsd })
			: 'none',
		limitOverrides,
	}
}

/**
 * Full {@link UserEntitlement} for a `users` row. Always attaches live seats
 * (runaway brake scales on every plan). Reads the wallet balance only for
 * wallet-eligible Pro accounts. Pass {@link balanceMicroUsd} when the caller
 * already loaded the wallet (for example `/account/usage`) so the balance is
 * not read twice.
 */
export async function resolveUserEntitlementFromRow(input: {
	db: D1Database
	stableUserId: string
	row: UserEntitlementRow
	now?: Date
	/** When set, skip the credit_wallets balance query. */
	balanceMicroUsd?: number
}): Promise<UserEntitlement> {
	const { plan, ladder, creditsEligible } = resolveUserPlanFromRow(
		input.row,
		input.now,
	)
	// Seats always attach: the execute runaway brake is seats × 300 on every
	// plan, and admin / resolveEntitlementLimit display must match admit.
	if (!creditsEligible) {
		const [seats, limitOverrides] = await Promise.all([
			readPaidSeats(input.db, input.stableUserId),
			readActiveOrgLimitOverrides(input.db, input.stableUserId, input.now),
		])
		return {
			plan,
			ladder,
			creditWallet: 'none',
			seats,
			limitOverrides,
		}
	}
	const [balanceMicroUsd, seats, limitOverrides] = await Promise.all([
		input.balanceMicroUsd !== undefined
			? input.balanceMicroUsd
			: readCreditWalletBalanceMicroUsd(input.db, input.stableUserId),
		readPaidSeats(input.db, input.stableUserId),
		readActiveOrgLimitOverrides(input.db, input.stableUserId, input.now),
	])
	return {
		plan,
		ladder,
		creditWallet: resolveCreditWalletState({
			plan,
			creditsEligible,
			balanceMicroUsd,
		}),
		seats,
		limitOverrides,
	}
}

/**
 * Paid seats for the org's rate pool: live owners + members, the same count
 * seat sync bills (at least 1).
 */
async function readPaidSeats(db: D1Database, orgId: string): Promise<number> {
	return Math.max(1, await countLiveSeats(db, orgId))
}

/**
 * The rate pool is seats × the per-seat include, so seats are read live for
 * pooled resources: a removed seat shrinks the pool on the next check, not
 * after the entitlement cache. The execute runaway brake also live-reads
 * seats so a seat change binds on the next admit.
 */
async function withLiveSeats(input: {
	db: D1Database
	orgId: string
	entitlement: UserEntitlement
	resource: EntitlementResource
}): Promise<UserEntitlement> {
	const needsLiveSeats =
		input.resource === 'execute_calls_per_minute' ||
		(input.entitlement.creditWallet !== 'none' &&
			isCreditsUnlockedResource(input.resource))
	if (!needsLiveSeats) {
		return input.entitlement
	}
	return {
		...input.entitlement,
		seats: await readPaidSeats(input.db, input.orgId),
	}
}

/**
 * Cached entitlement with live seats (when the resource pools by seats) and
 * live limit overrides (when the resource is overridable). Used by counted
 * checks and the execute runaway brake so a seat or override change binds
 * on the next call.
 */
export async function resolveLiveEntitlementForResource(input: {
	db: D1Database
	userId: OwnerId
	email: string | null | undefined
	resource: EntitlementResource
	now?: Date
}): Promise<UserEntitlement> {
	const now = input.now ?? new Date()
	return await withLiveSeats({
		db: input.db,
		orgId: input.userId,
		entitlement: await withLiveLimitOverrides({
			db: input.db,
			orgId: input.userId,
			entitlement: getCachedUserEntitlement(input.db, {
				userId: input.userId,
				email: input.email,
			}),
			resource: input.resource,
			now,
		}),
		resource: input.resource,
	})
}

/**
 * Resolve the effective plan, entitlement ladder, and credit wallet state
 * for a user. Missing userId, invalid stable ids, and no matching row
 * resolve to public `free` without warning. Stored plan values go through
 * strict {@link parseStoredPlanName}; the ladder goes through
 * {@link parseEntitlementLadder}.
 *
 * The MCP `userId` is the account's stored `users.stable_user_id`. Lookup
 * uses the real account email + stable id pair when both are available so a
 * mismatched caller context cannot resolve another account's plan. Background
 * contexts with a blank/missing email reverse-resolve by stable id. Missing or
 * invalid stable ids still fail closed to public `free` without touching D1.
 *
 * Effective plan = f(manual orgs.plan, orgs.stripe_plan, unexpired
 * Pro overlays): the higher-ranked of the manual grant and Stripe
 * subscription plan, then a public Pro overlay when the later of the
 * second-agent gift and stacked referral credit is still active and the
 * base plan is still free. Overlay Pro uses the retired Pro table (no
 * wallet). `legacy` ceilings apply only while that marker stays set and
 * paid access remains continuous. The credit wallet is `funded` only for
 * the purchasable Pro with a positive balance.
 */
type UserEntitlementLookupRow = UserEntitlementRow & {
	/** Personal (or team) org id for wallet / seat / override reads. */
	org_id: string
}

async function loadEntitlementRowForStableUserId(
	db: D1Database,
	input: { stableUserId: string; email: string | null | undefined },
): Promise<UserEntitlementLookupRow | null> {
	const orgColumns = userEntitlementColumnsSql('o')
	const email = input.email?.trim().toLowerCase()

	// When email is provided, require a live users row for that email whose
	// person id or personal org id matches the caller id — owner-keyed hot
	// paths pass the personal org id with the owner's email
	// (`ownerIdFromCaller` + `entitlementEmailForOwner`). A mismatched email
	// must not inherit another account's plan (team org id + member email
	// stays Free). Entitlement columns come from `orgs` only; `org_id` is the
	// owner key for wallets, seats, and overrides.
	if (email) {
		return await db
			.prepare(
				`SELECT o.id AS org_id, ${orgColumns}
				 FROM users u
				 ${joinOrgsOnPersonalOrgIdSql}${andLiveDeletedAtSql('o')}
				 WHERE u.email = ?
				   AND (u.stable_user_id = ? OR u.personal_org_id = ?)
				   AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}`,
			)
			.bind(email, input.stableUserId, input.stableUserId)
			.first<UserEntitlementLookupRow>()
	}

	return await db
		.prepare(
			`SELECT o.id AS org_id, ${orgColumns} FROM orgs o WHERE o.id = ?${andLiveDeletedAtSql('o')}`,
		)
		.bind(input.stableUserId)
		.first<UserEntitlementLookupRow>()
}

export async function getUserEntitlement(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<UserEntitlement> {
	const email = input.email?.trim().toLowerCase()
	if (!input.userId) return publicFreeEntitlement
	if (!stableUserIdPattern.test(input.userId)) return publicFreeEntitlement
	const row = await loadEntitlementRowForStableUserId(db, {
		stableUserId: input.userId,
		email,
	})
	if (!row) return publicFreeEntitlement
	const { org_id: orgId, ...entitlementRow } = row
	return await resolveUserEntitlementFromRow({
		db,
		// Wallets, seats, and overrides are owner-keyed (orgs.id), which may
		// differ from the person id when personal_org_id is distinct.
		stableUserId: (orgId ?? '').trim() || input.userId,
		row: entitlementRow,
	})
}

/**
 * Resolve the effective plan for a user. Always returns a {@link PlanName}
 * (never a meaningful null): missing userId, invalid stable ids, and no
 * matching row resolve to `free` without warning; stored values go through
 * strict {@link parseStoredPlanName} validation and throw if D1 violates the
 * plan CHECK constraint.
 */
export async function getUserPlan(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<PlanName> {
	return (await getUserEntitlement(db, input)).plan
}

export type StableUserAccount = {
	email: string
	plan: PlanName
	/** Whether users.email_verified_at is set. */
	emailVerified: boolean
}

/**
 * Short-TTL caches for the plan / account lookups that run on metered hot
 * paths (every new execute worker and every sandbox outbound fetch pays one). The
 * quota counter write itself stays atomic and uncached; only the plan-limit
 * resolution tolerates staleness, so a plan change takes effect for quota
 * checks within {@link entitlementLookupCacheTtlMs} instead of immediately.
 * Keyed by the `D1Database` binding so test databases never share entries.
 */
const entitlementLookupCacheTtlMs = 60_000
const entitlementLookupCacheMaxEntries = 1_000

type EntitlementLookupCacheEntry<T> = {
	value: Promise<T>
	expiresAtMs: number
}

function createEntitlementLookupCache<T>() {
	const cachesByDb = new WeakMap<
		D1Database,
		Map<string, EntitlementLookupCacheEntry<T>>
	>()
	return {
		async getOrCreate(
			db: D1Database,
			key: string,
			create: () => Promise<T>,
		): Promise<T> {
			let cache = cachesByDb.get(db)
			if (!cache) {
				cache = new Map()
				cachesByDb.set(db, cache)
			}
			const nowMs = Date.now()
			const existing = cache.get(key)
			if (existing && existing.expiresAtMs > nowMs) {
				return await existing.value
			}
			const value = create()
			// Never cache failures: a D1 blip must not pin an error for the TTL.
			value.catch(() => {
				if (cache.get(key)?.value === value) cache.delete(key)
			})
			if (cache.size >= entitlementLookupCacheMaxEntries) {
				const oldestKey = cache.keys().next().value
				if (oldestKey !== undefined) cache.delete(oldestKey)
			}
			cache.set(key, {
				value,
				expiresAtMs: nowMs + entitlementLookupCacheTtlMs,
			})
			return await value
		},
		deleteByKeyPrefix(db: D1Database, keyPrefix: string) {
			const cache = cachesByDb.get(db)
			if (!cache) return
			for (const key of [...cache.keys()]) {
				if (key.startsWith(keyPrefix)) cache.delete(key)
			}
		},
	}
}

const cachedUserEntitlements = createEntitlementLookupCache<UserEntitlement>()
const cachedStableUserAccounts =
	createEntitlementLookupCache<StableUserAccount | null>()

/**
 * {@link getUserEntitlement} behind the short-TTL hot-path cache. Use only
 * where a plan or ladder change may take up to a minute to apply (quota
 * limit resolution); interactive plan displays should keep calling
 * {@link getUserEntitlement}.
 */
export async function getCachedUserEntitlement(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<UserEntitlement> {
	const email = input.email?.trim().toLowerCase()
	if (!input.userId) return publicFreeEntitlement
	if (!stableUserIdPattern.test(input.userId)) return publicFreeEntitlement
	return await cachedUserEntitlements.getOrCreate(
		db,
		`${input.userId}\n${email ?? ''}`,
		async () => await getUserEntitlement(db, input),
	)
}

/**
 * Drop this isolate's cached entitlements for an org so the next lookup
 * re-reads D1. Other isolates cannot be reached, which is why counted
 * checks also read limit overrides live ({@link withLiveLimitOverrides}).
 */
export function invalidateCachedUserEntitlement(
	db: D1Database,
	orgId: string,
): void {
	cachedUserEntitlements.deleteByKeyPrefix(db, `${orgId}\n`)
}

/**
 * Replace the (possibly cached) overrides with a live D1 read when the
 * resource has an overridable limit. The per-isolate entitlement cache can
 * only be invalidated in the isolate that wrote, so an override change must
 * not wait out the cache TTL anywhere else.
 */
async function withLiveLimitOverrides(input: {
	db: D1Database
	orgId: string
	entitlement: Promise<UserEntitlement>
	resource: EntitlementResource
	now: Date
}): Promise<UserEntitlement> {
	if (!isLimitOverrideResource(input.resource)) {
		return await input.entitlement
	}
	const [entitlement, limitOverrides] = await Promise.all([
		input.entitlement,
		stableUserIdPattern.test(input.orgId)
			? readActiveOrgLimitOverrides(input.db, input.orgId, input.now)
			: [],
	])
	// The fail-closed public Free fallback (unknown org or mismatched
	// caller) carries no overrides and must not gain any here.
	if (entitlement.limitOverrides === undefined) return entitlement
	return { ...entitlement, limitOverrides }
}

/**
 * {@link getUserPlan} behind the short-TTL hot-path cache. Use only where a
 * plan change may take up to a minute to apply (quota limit resolution);
 * interactive plan displays should keep calling {@link getUserPlan}.
 */
export async function getCachedUserPlan(
	db: D1Database,
	input: { userId: string; email: string | null | undefined },
): Promise<PlanName> {
	return (await getCachedUserEntitlement(db, input)).plan
}

/**
 * {@link findUserAccountByStableUserId} behind the short-TTL hot-path cache,
 * for per-fetch account reverse-resolution in the fetch gateway.
 */
export async function findCachedUserAccountByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<StableUserAccount | null> {
	const trimmed = stableUserId.trim()
	if (!trimmed) return null
	return await cachedStableUserAccounts.getOrCreate(
		db,
		trimmed,
		async () => await findUserAccountByStableUserId(db, trimmed),
	)
}

/**
 * Reverse-resolve a stable MCP userId back to the account email, personal-org
 * plan, and verified-email state via the indexed `users.stable_user_id`.
 * Only call this on paths that genuinely have no caller context email (for
 * example package-runtime contexts acting with only the stable userId);
 * inbound email routing resolves accounts via the indexed username lookup
 * and interactive surfaces already carry the email.
 */
export async function findUserAccountByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<StableUserAccount | null> {
	const trimmed = stableUserId.trim()
	if (!trimmed) return null
	const row = await db
		.prepare(
			`SELECT u.email, o.plan, u.email_verified_at
			 FROM users u
			 ${joinOrgsOnPersonalOrgIdSql}${andLiveDeletedAtSql('o')}
			 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
		)
		.bind(trimmed)
		.first<{
			email: string
			plan: string
			email_verified_at: string | null
		}>()
	if (!row) return null
	return {
		email: row.email,
		plan: parseStoredPlanName(row.plan),
		emailVerified: Boolean(row.email_verified_at),
	}
}

function assertDailyEntitlementResource(
	resource: EntitlementResource,
): DailyEntitlementResource {
	if (!isDailyEntitlementResource(resource)) {
		throw new Error(
			`Expected a daily entitlement resource; got ${JSON.stringify(resource)}.`,
		)
	}
	return resource
}

/**
 * Seed a missing UserMeter `(resource, day)` at zero. `INSERT OR IGNORE`
 * inside the DO keeps concurrent cold callers safe.
 */
async function ensureUserMeterCounterInitializedAtZero(input: {
	env: UserMeterEnv
	userId: OwnerId
	resource: DailyEntitlementResource
	day: string
	updatedAt: string
}) {
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	await meter.initialize({
		resource: input.resource,
		day: input.day,
		count: 0,
		updatedAt: input.updatedAt,
	})
}

/**
 * Point-read one daily entitlement counter from UserMeter. Cold meters
 * initialize the `(resource, day)` at zero, then re-read; warm meters return
 * the DO count. Never touches D1 daily counter state.
 */
export async function readDailyEntitlementResourceUsage(input: {
	env: UserMeterEnv
	userId: OwnerId
	resource: EntitlementResource
	now?: Date
}): Promise<number> {
	const resource = assertDailyEntitlementResource(input.resource)
	const now = input.now ?? new Date()
	const day = utcDayKey(now)
	const updatedAt = now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	let result = await meter.read({
		resource,
		day,
		now: updatedAt,
	})
	if (result.outcome === 'needs_bootstrap') {
		await ensureUserMeterCounterInitializedAtZero({
			env: input.env,
			userId: input.userId,
			resource,
			day,
			updatedAt,
		})
		result = await meter.read({
			resource,
			day,
			now: updatedAt,
		})
		if (result.outcome === 'needs_bootstrap') {
			throw new Error(
				'UserMeter daily entitlement read still needs bootstrap after initialize.',
			)
		}
	}
	return result.count
}

/**
 * Sum UserMeter daily rows for the UTC week containing `now`. Missing days
 * count as zero; does not bootstrap today's key.
 */
export async function readWeeklyEntitlementResourceUsage(input: {
	env: UserMeterEnv
	userId: OwnerId
	resource: EntitlementResource
	now?: Date
}): Promise<number> {
	const resource = assertDailyEntitlementResource(input.resource)
	const now = input.now ?? new Date()
	const startDay = utcWeekStart(now)
	const endDay = utcDayKey(now)
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const result = await meter.readRange({
		resource,
		startDay,
		endDay,
		now: now.toISOString(),
	})
	return result.count
}

/**
 * Authoritative UserMeter slice for an entitlement usage snapshot: every
 * requested daily counter, weekly window, and optional storage bytes in one
 * Durable Object hop (cold keys still bootstrap then re-read once). Point
 * readers keep {@link readDailyEntitlementResourceUsage},
 * {@link readWeeklyEntitlementResourceUsage}, and
 * {@link readStorageBytesFromUserMeter}.
 */
export type UserMeterEntitlementUsageCounts = {
	daily: Partial<Record<DailyEntitlementResource, number>>
	weekly: Partial<Record<DailyEntitlementResource, number>>
	storageBytes: number | null
}

export async function readUserMeterEntitlementUsageSnapshot(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: OwnerId
	now: Date
	dailyResources: ReadonlyArray<DailyEntitlementResource>
	weeklyResources: ReadonlyArray<DailyEntitlementResource>
	includeStorageBytes: boolean
}): Promise<UserMeterEntitlementUsageCounts> {
	const day = utcDayKey(input.now)
	const weekStart = utcWeekStart(input.now)
	const updatedAt = input.now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const request = {
		day,
		weekStart,
		dailyResources: input.dailyResources,
		weeklyResources: input.weeklyResources,
		includeStorageBytes: input.includeStorageBytes,
		now: updatedAt,
	}

	let snapshot = await meter.readUsageSnapshot(request)
	const missingDaily = snapshot.daily
		.filter((entry) => entry.outcome === 'needs_bootstrap')
		.map((entry) => entry.resource)
	const storageNeedsBootstrap =
		input.includeStorageBytes &&
		snapshot.storageBytes?.outcome === 'needs_bootstrap'
	let storageBootstrapSkipped = false

	if (missingDaily.length > 0 || storageNeedsBootstrap) {
		const accountExists = storageNeedsBootstrap
			? await userAccountRowExists({
					db: input.db,
					userId: input.userId,
				})
			: false
		storageBootstrapSkipped = Boolean(storageNeedsBootstrap && !accountExists)
		const shouldInitializeStorage = Boolean(
			storageNeedsBootstrap && accountExists,
		)
		await Promise.all([
			...missingDaily.map((resource) =>
				ensureUserMeterCounterInitializedAtZero({
					env: input.env,
					userId: input.userId,
					resource,
					day,
					updatedAt,
				}),
			),
			shouldInitializeStorage
				? seedStorageBytesFromPhysical({
						db: input.db,
						env: input.env,
						userId: input.userId,
						now: input.now,
					}).then(() => undefined)
				: Promise.resolve(),
		])
		if (missingDaily.length > 0 || shouldInitializeStorage) {
			snapshot = await meter.readUsageSnapshot(request)
		}
	}

	return countsFromUserMeterUsageSnapshot({
		snapshot,
		dailyResources: input.dailyResources,
		weeklyResources: input.weeklyResources,
		includeStorageBytes: input.includeStorageBytes,
		storageBootstrapSkipped,
	})
}

function countsFromUserMeterUsageSnapshot(input: {
	snapshot: UserMeterUsageSnapshotResult
	dailyResources: ReadonlyArray<DailyEntitlementResource>
	weeklyResources: ReadonlyArray<DailyEntitlementResource>
	includeStorageBytes: boolean
	storageBootstrapSkipped: boolean
}): UserMeterEntitlementUsageCounts {
	const daily: Partial<Record<DailyEntitlementResource, number>> = {}
	for (const resource of input.dailyResources) {
		const entry = input.snapshot.daily.find((row) => row.resource === resource)
		if (!entry || entry.outcome === 'needs_bootstrap') {
			throw new Error(
				`UserMeter usage snapshot daily read still needs bootstrap for ${resource}.`,
			)
		}
		daily[resource] = entry.count
	}

	const weekly: Partial<Record<DailyEntitlementResource, number>> = {}
	for (const resource of input.weeklyResources) {
		const entry = input.snapshot.weekly.find((row) => row.resource === resource)
		if (!entry) {
			throw new Error(
				`UserMeter usage snapshot omitted weekly count for ${resource}.`,
			)
		}
		weekly[resource] = entry.count
	}

	if (!input.includeStorageBytes) {
		return { daily, weekly, storageBytes: null }
	}
	if (input.storageBootstrapSkipped) {
		return { daily, weekly, storageBytes: 0 }
	}
	const storage = input.snapshot.storageBytes
	if (!storage || storage.outcome === 'needs_bootstrap') {
		throw new Error(
			'UserMeter usage snapshot storage bytes still need bootstrap after initialize.',
		)
	}
	return { daily, weekly, storageBytes: storage.bytes }
}

async function countRows(db: D1Database, sql: string, params: Array<unknown>) {
	const row = await db
		.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

const entitlementByteEncoder = new TextEncoder()

function utf8ByteLength(value: string) {
	return entitlementByteEncoder.encode(value).byteLength
}

function serializeByteEstimateValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (value === undefined) return 'undefined'
	try {
		return JSON.stringify(value) ?? 'null'
	} catch {
		return String(value)
	}
}

export function estimateEntitlementStorageBytes(value: unknown): number {
	return utf8ByteLength(serializeByteEstimateValue(value))
}

export function estimateEntitlementStorageEntryBytes(input: {
	key?: string | null
	value: unknown
}) {
	return (
		(input.key ? estimateEntitlementStorageBytes(input.key) : 0) +
		estimateEntitlementStorageBytes(input.value)
	)
}

export function estimateEntitlementStorageByteDelta(input: {
	nextBytes: number
	existingBytes?: number | null
}) {
	return Math.max(0, input.nextBytes - (input.existingBytes ?? 0))
}

export function estimateEntitlementStorageEntryByteDelta(input: {
	next: { key?: string | null; value: unknown }
	existing?: { key?: string | null; value: unknown } | null
}) {
	return estimateEntitlementStorageByteDelta({
		nextBytes: estimateEntitlementStorageEntryBytes(input.next),
		existingBytes: input.existing
			? estimateEntitlementStorageEntryBytes(input.existing)
			: 0,
	})
}

export function estimateEntitlementStorageSqlWriteBytes(input: {
	query: string
	params?: Array<unknown>
}) {
	return estimateEntitlementStorageEntryBytes({
		value: {
			query: input.query,
			params: input.params ?? [],
		},
	})
}

function textBytesExpression(columns: ReadonlyArray<string>) {
	return columns
		.map((column) => `length(CAST(COALESCE(${column}, '') AS BLOB))`)
		.join(' + ')
}

function isMissingStorageByteSurfaceError(error: unknown) {
	return (
		error instanceof Error && /\bno such (table|column)\b/i.test(error.message)
	)
}

async function sumStorageBytes(
	db: D1Database,
	sql: string,
	params: Array<unknown>,
) {
	const row = await db
		.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
		.catch((error: unknown) => {
			if (isMissingStorageByteSurfaceError(error)) return null
			throw error
		})
	return Number(row?.count ?? 0)
}

/**
 * Authoritative D1 payload scan. This is intentionally reserved for migration
 * backfills and the bounded reconciliation lane; entitlement checks must use
 * the stored point-read counter below.
 */
export async function calculateUserD1StorageBytes(input: {
	db: D1Database
	userId: OwnerId
	/**
	 * Jobs-data access for the jobs-worker database (ADR 0016). Job rows no
	 * longer live in APP_DB; when provided, their byte estimate is included
	 * in the total so jobs keep counting toward the D1 storage quota.
	 */
	jobs?: JobsStore
}) {
	const { db, userId } = input
	const sums = await Promise.all([
		input.jobs
			? input.jobs
					.sumJobsStorageBytesForUser({ userId })
					.catch((error: unknown) => {
						// Local/test APP_DB often has no jobs table when the JOBS
						// binding is absent (ADR 0016). Match the other surfaces.
						if (isMissingStorageByteSurfaceError(error)) return 0
						throw error
					})
			: Promise.resolve(0),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'se.name',
					'se.description',
					'se.encrypted_value',
					'se.allowed_hosts',
					'se.allowed_packages',
				])}
			), 0) AS count
			FROM secret_entries se
			JOIN secret_buckets sb ON sb.id = se.bucket_id
			WHERE sb.user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'category',
					'subject',
					'summary',
					'details',
					'tags_json',
					'source_uris_json',
					'dedupe_key',
				])}
			), 0) AS count
			FROM mcp_memories
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'name',
					'kody_id',
					'description',
					'tags_json',
					'search_text',
					'source_id',
				])}
			), 0) AS count
			FROM saved_packages
			WHERE user_id = ?`,
			[userId],
		),
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'entity_kind',
					'entity_id',
					'repo_id',
					'published_commit',
					'indexed_commit',
					'manifest_path',
					'source_root',
				])}
			), 0) AS count
			FROM entity_sources
			WHERE user_id = ?`,
			[userId],
		),
		// Run records and the keyed package-invocation idempotency ledger live
		// in the per-user RunLog Durable Object (the D1 package_invocations
		// table was dropped). Both are self-expiring operational state, not
		// user content, and are intentionally excluded from the storage quota.
		sumStorageBytes(
			db,
			`SELECT COALESCE(SUM(
				${textBytesExpression([
					'source_id',
					'artifact_kind',
					'artifact_name',
					'entry_point',
					'published_commit',
					'kv_key',
					'dependencies_json',
				])}
			), 0) AS count
			FROM published_bundle_artifacts
			WHERE user_id = ?`,
			[userId],
		),
	])
	return sums.reduce((total, value) => total + value, 0)
}

/**
 * Whether a real billing subject exists for this owner id. Personal orgs
 * appear in `users.stable_user_id`; team orgs only in `orgs`. Synthetic
 * contexts (neither row) must never materialize durable UserMeter state.
 */
async function userAccountRowExists(input: {
	db: D1Database
	userId: OwnerId
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT 1 AS present FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}
			 UNION ALL
			 SELECT 1 AS present FROM orgs WHERE id = ?${andLiveDeletedAtSql()}
			 LIMIT 1`,
		)
		.bind(input.userId, input.userId)
		.first<{ present: number }>()
	return row != null
}

/**
 * Cold-only physical seed for a missing UserMeter storage singleton.
 * Computes the D1 payload sum and `initializeStorageBytes` (INSERT OR IGNORE).
 * Never CAS/absolute-sets a live meter — that would wipe reservations for
 * bytes reserved but not yet written. The keyset reconcile lane owns CAS.
 * On an init race, re-reads the winner's value.
 */
export async function bootstrapOwnerD1StorageBytes(input: {
	db: D1Database
	userId: OwnerId
	now?: Date
	/** Required because UserMeter is the storage-usage authority. */
	env: UserMeterEnv
	/** Jobs-worker byte contribution (see calculateUserD1StorageBytes). */
	jobs?: JobsStore
}): Promise<{ bytes: number; created: boolean }> {
	const nowIso = (input.now ?? new Date()).toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const current = await meter.readStorageBytes()
	if (current.outcome === 'ready') {
		return { bytes: current.bytes, created: false }
	}
	const bytes = await calculateUserD1StorageBytes(input)
	const initResult = await meter.initializeStorageBytes({
		bytes,
		updatedAt: nowIso,
	})
	if (initResult.created) {
		return { bytes, created: true }
	}
	const after = await meter.readStorageBytes()
	if (after.outcome === 'needs_bootstrap') {
		throw new Error(
			'UserMeter storage bytes still need bootstrap after cold init race.',
		)
	}
	return { bytes: after.bytes, created: false }
}

/**
 * Recompute one user's authoritative storage bytes from D1 payload tables
 * (physical source of truth) and set UserMeter via a revision-guarded CAS.
 *
 * Flow:
 * 1. Read current UserMeter revision BEFORE computing the physical sum.
 * 2. Compute the physical sum from D1 payload tables.
 * 3a. If the meter was missing (`needs_bootstrap`): initialize it. If another
 *    caller already created the singleton, defer to the next sweep (their
 *    state is correct; do not overwrite).
 * 3b. If the meter was present: CAS with the captured revision. A concurrent
 *    reserve that bumped the revision causes a CAS miss → defer to next sweep.
 *
 * Returns `{ bytes, updated, deferred }`. `deferred` is true when a CAS miss
 * or init race prevented the write; the row should be rotated for retry.
 * `deferred` is never a failure and is not counted as `updated`.
 *
 * Hot cold-bootstrap callers must use {@link bootstrapOwnerD1StorageBytes}
 * (or {@link enqueueOwnerD1StorageReconcile}) instead — those never CAS a
 * live meter.
 */
export async function reconcileUserD1StorageBytes(input: {
	db: D1Database
	userId: OwnerId
	now?: Date
	/** Required because UserMeter is the storage-usage authority. */
	env: UserMeterEnv
	/** Jobs-worker byte contribution (see calculateUserD1StorageBytes). */
	jobs?: JobsStore
}): Promise<{ bytes: number; updated: boolean; deferred: boolean }> {
	const nowIso = (input.now ?? new Date()).toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })

	// Step 1: Capture meter revision BEFORE computing physical sum.
	const currentState = await meter.readStorageBytes()

	if (currentState.outcome === 'needs_bootstrap') {
		// Cold init path: compute physical sum and initialize the singleton.
		const bytes = await calculateUserD1StorageBytes(input)
		const initResult = await meter.initializeStorageBytes({
			bytes,
			updatedAt: nowIso,
		})
		if (!initResult.created) {
			// Init race: another caller created the singleton between read and
			// initializeStorageBytes; do not overwrite their state. Defer.
			return { bytes, updated: false, deferred: true }
		}
		return { bytes, updated: true, deferred: false }
	}

	// Step 2: Capture the revision from the pre-computation read.
	const capturedRevision = currentState.revision

	// Step 3: Compute physical sum AFTER capturing revision.
	const bytes = await calculateUserD1StorageBytes(input)

	// Step 4: CAS — apply only when revision still matches.
	const casResult = await meter.reconcileStorageBytes({
		bytes,
		expectedRevision: capturedRevision,
		updatedAt: nowIso,
	})

	if (casResult.outcome === 'needs_bootstrap') {
		// Meter was purged between read and CAS (e.g. account deletion).
		// Defer so the next sweep can re-initialize cleanly.
		return { bytes, updated: false, deferred: true }
	}

	if (!casResult.applied) {
		// CAS miss: a concurrent reserve bumped the revision between capture and
		// CAS. Do not overwrite — defer to next sweep when the meter is quiet.
		return { bytes, updated: false, deferred: true }
	}

	return { bytes, updated: true, deferred: false }
}

/**
 * Live storage owners: personal orgs (`users.stable_user_id`) and team orgs
 * (`orgs.id`, which have no `users` row). Personal org ids appear in both
 * tables; `UNION` dedupes them.
 */
const liveStorageOwnerIdsSql = `SELECT stable_user_id AS owner_id FROM users WHERE ${liveDeletedAtSql()}
	UNION
	SELECT id AS owner_id FROM orgs WHERE ${liveDeletedAtSql()}`

/**
 * Keyset sweep page for the reconcile lane. The platform-owned
 * `d1_storage_reconcile_cursor` singleton stores the last processed owner id;
 * pages walk live owner ids (personal and team orgs) ascending and wrap to the
 * start when the tail is reached. No per-owner cursor state exists.
 */
export async function listUsersForD1StorageReconciliation(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ userId: OwnerId }>> {
	const cursorRow = await input.db
		.prepare(
			`SELECT position FROM d1_storage_reconcile_cursor
			WHERE singleton = 1`,
		)
		.first<{ position: string }>()
	const lastUserId = cursorRow?.position ?? ''
	const page = await input.db
		.prepare(
			`SELECT owner_id AS userId
			FROM (${liveStorageOwnerIdsSql})
			WHERE owner_id > ?
			ORDER BY owner_id ASC LIMIT ?`,
		)
		.bind(lastUserId, input.limit)
		.all<{ userId: OwnerId }>()
	const rows = page.results ?? []
	if (rows.length > 0 || lastUserId === '') return rows
	// Tail reached: wrap to the start of the keyset for the next full sweep.
	const wrapped = await input.db
		.prepare(
			`SELECT owner_id AS userId
			FROM (${liveStorageOwnerIdsSql})
			ORDER BY owner_id ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<{ userId: OwnerId }>()
	return wrapped.results ?? []
}

/** Advance the reconcile-lane keyset cursor past the processed page. */
export async function advanceD1StorageReconciliationCursor(input: {
	db: D1Database
	lastUserId: string
	now?: Date
}) {
	await input.db
		.prepare(
			`UPDATE d1_storage_reconcile_cursor
			SET position = ?, updated_at = ?
			WHERE singleton = 1`,
		)
		.bind(input.lastUserId, (input.now ?? new Date()).toISOString())
		.run()
}

export async function readEntitlementResourceUsage(input: {
	db: D1Database
	userId: OwnerId
	resource: EntitlementResource
	now: Date
}): Promise<number> {
	const { db, userId, resource, now } = input
	switch (resource) {
		case 'repos':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM user_repos WHERE user_id = ?`,
				[userId],
			)
		case 'saved_packages':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM saved_packages WHERE user_id = ?`,
				[userId],
			)
		case 'scheduled_jobs':
			throw new Error(
				'scheduled_jobs usage must be read from jobsData (pass getCurrent or use readCurrentEntitlementResourceUsage).',
			)
		case 'repo_sessions':
			throw new Error(
				'repo_sessions usage must be read from RepoSessionIndex (use readCurrentEntitlementResourceUsage or pass getCurrent with countActiveRepoSessions).',
			)
		case 'email_sends_per_day':
		case 'email_receives_per_day':
		case 'execute_unique_workers_per_day':
		case 'outbound_fetches_per_day':
		case 'job_runs_per_day':
		case 'automation_invocations_per_day':
			// Authoritative daily counters live in UserMeter. Callers must use
			// consumeDailyEntitlement / readDailyEntitlementResourceUsage /
			// readCurrentEntitlementResourceUsage. There is no D1 daily-counter
			// table.
			throw new Error(
				`${resource} usage must be read from UserMeter (use readDailyEntitlementResourceUsage or readCurrentEntitlementResourceUsage).`,
			)
		case 'stored_email_messages':
			throw new Error(
				'stored_email_messages usage must be read from Mailbox (use readCurrentEntitlementResourceUsage).',
			)
		case 'secrets':
			return await countRows(
				db,
				`SELECT COUNT(*) AS count FROM secret_entries se
				JOIN secret_buckets sb ON sb.id = se.bucket_id
				WHERE sb.user_id = ?
					AND (sb.expires_at IS NULL OR sb.expires_at > ?)`,
				[userId, now.toISOString()],
			)
		case 'concurrent_workflows':
			// Authoritative concurrent-workflow occupancy lives in per-user
			// RunLog `workflow_projections`. Callers must pass getCurrent from
			// reserveWorkflowProjectionSlot (create path) or use
			// readCurrentEntitlementResourceUsage (usage readers).
			throw new Error(
				'concurrent_workflows usage must be read from RunLog (pass getCurrent or use readCurrentEntitlementResourceUsage).',
			)
		case 'storage_bytes':
			// Authoritative storage bytes live in UserMeter. Callers must use
			// readCurrentEntitlementResourceUsage (which reads UserMeter with
			// cold bootstrap) or assertWithinStorageBytesEntitlement (DO
			// reserve); calculateUserD1StorageBytes is the physical recompute
			// used by cold bootstrap and the reconcile lane.
			throw new Error(
				'storage_bytes usage must be read from UserMeter (use readCurrentEntitlementResourceUsage).',
			)
		case 'email_message_bytes':
			// Per-message limit, not an accumulating counter: enforcement
			// passes the candidate message size via getCurrent.
			throw new Error(
				'email_message_bytes has no built-in counter; pass getCurrent to assertWithinEntitlement.',
			)
		case 'execute_calls_per_minute':
			// In-memory runaway brake on UserMeter.admitExecuteCall, not a
			// durable accumulating counter.
			throw new Error(
				'execute_calls_per_minute has no built-in counter; resolve the limit and pass it to admitExecuteCall.',
			)
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}

/**
 * Seed a cold UserMeter storage singleton from the physical D1 payload sum
 * via the shared lazy enqueue (cold init only — never CAS). Usage reads use
 * this so a cold or purged meter reflects real bytes immediately instead of
 * zero-init. Scan failures propagate (fail closed): we do not materialize an
 * inaccurate zero that would understate usage and StorageRunner baselines.
 */
function jobsStoreForOwnerStorageReconcile(
	db: D1Database,
	env?: Partial<Pick<Env, 'JOBS'>>,
) {
	// JOBS is optional at runtime (falls back to APP_DB); JobsDataEnv types it
	// as required because generated Env lists the binding.
	return jobsData({ APP_DB: db, JOBS: env?.JOBS } as JobsDataEnv)
}

async function seedStorageBytesFromPhysical(input: {
	db: D1Database
	env: UserMeterEnv & Partial<Pick<Env, 'JOBS'>>
	userId: OwnerId
	now: Date
}): Promise<number> {
	await enqueueOwnerD1StorageReconcile({
		db: input.db,
		env: input.env,
		userId: input.userId,
		now: input.now,
		jobs: jobsStoreForOwnerStorageReconcile(input.db, input.env),
	})
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const result = await meter.readStorageBytes()
	if (result.outcome === 'needs_bootstrap') {
		throw new Error(
			'UserMeter storage bytes still need bootstrap after physical seed.',
		)
	}
	return result.bytes
}

/**
 * Read current storage bytes from UserMeter with cold bootstrap. On
 * `needs_bootstrap`, seeds the singleton from the physical D1 payload sum
 * and retries. The bounded reconcile lane (and reserve-path lazy enqueue)
 * continue to correct drift via CAS. Always returns the authoritative DO
 * byte count.
 */
export async function readStorageBytesFromUserMeter(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: OwnerId
	now: Date
}): Promise<number> {
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const result = await meter.readStorageBytes()
	if (result.outcome === 'needs_bootstrap') {
		// Synthetic/unknown contexts have no account row. Preserve their zero
		// usage semantics without materializing durable state for a non-user.
		if (!(await userAccountRowExists(input))) return 0
		return await seedStorageBytesFromPhysical(input)
	}
	return result.bytes
}

/**
 * Authoritative current usage for any entitlement resource: daily counters
 * via UserMeter, concurrent workflows via RunLog workflow projections, and
 * everything else via the legacy D1 helpers.
 */
export async function readCurrentEntitlementResourceUsage(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: OwnerId
	resource: EntitlementResource
	now: Date
}): Promise<number> {
	if (isDailyEntitlementResource(input.resource)) {
		return await readDailyEntitlementResourceUsage({
			env: input.env,
			userId: input.userId,
			resource: input.resource,
			now: input.now,
		})
	}
	if (input.resource === 'concurrent_workflows') {
		return await countActiveWorkflowProjections({
			env: input.env as Env,
			userId: input.userId,
		})
	}
	if (input.resource === 'storage_bytes') {
		return await readStorageBytesFromUserMeter({
			db: input.db,
			env: input.env,
			userId: input.userId,
			now: input.now,
		})
	}
	if (input.resource === 'stored_email_messages') {
		return await countInternalUserEmailMessages({
			env: input.env,
			ownerId: input.userId,
		})
	}
	if (input.resource === 'repo_sessions') {
		return await countActiveRepoSessions(input.env, input.userId)
	}
	if (input.resource === 'scheduled_jobs') {
		return await jobsData({
			JOBS: input.env.JOBS,
			APP_DB: input.db,
		}).countJobsForUser({
			userId: input.userId,
		})
	}
	return await readEntitlementResourceUsage({
		db: input.db,
		userId: input.userId,
		resource: input.resource,
		now: input.now,
	})
}

/** Bounded retries for cold bootstrap contention (concurrent callers may both attempt initializeStorageBytes). */
const storageBytesBootstrapMaxAttempts = 2

/**
 * Atomically reserve storage bytes in the per-user UserMeter Durable Object.
 * On `needs_bootstrap`, lazily enqueues (and awaits) an immediate per-owner
 * physical reconcile so concurrent cold reserves share one D1 SUM and the
 * meter seeds from real payload bytes instead of zero. Scan failures
 * propagate (fail closed) — we do not zero-init after a failed scan, which
 * would under-enforce until the keyset sweep. The bounded reconcile lane
 * remains the backstop for drift via CAS.
 * Missing-user synthetic contexts (no account row) preserve current free-plan
 * allow/deny semantics without touching the DO.
 *
 * `getCurrent` is a check-only path for StorageRunner bucket totals and does
 * not reserve in UserMeter; `env` is not required on that path.
 *
 * The `env` / `USER_METER` binding is required for the DO reserve path and
 * throws immediately when absent — failing closed for real users.
 */
/** Charged-org paths for plan-limit denials (Usage first; Billing for upgrades). */
export type EntitlementOrgPaths = {
	orgSlug: string | null
	billingPath: string
	usagePath: string | null
}

/**
 * Signup/charged org slug plus Usage and Billing paths. Billing falls back to
 * a placeholder when the org cannot be read so denials still render.
 */
export async function entitlementOrgPaths(
	db: D1Database,
	userId: string,
): Promise<EntitlementOrgPaths> {
	try {
		const org = await getOrgById(db, userId)
		if (org?.slug) {
			return {
				orgSlug: org.slug,
				billingPath: orgBillingPath(org.slug),
				usagePath: orgUsagePath(org.slug),
			}
		}
	} catch {
		// A test double that does not model orgs still owes the caller a limit
		// error. Production D1 returns null when the org is missing.
	}
	return {
		orgSlug: null,
		billingPath: '/@<slug>/-/billing',
		usagePath: null,
	}
}

/** Signup org billing page, or a placeholder when the org cannot be read. */
export async function entitlementBillingPath(db: D1Database, userId: string) {
	return (await entitlementOrgPaths(db, userId)).billingPath
}

/**
 * The storage byte limit {@link assertWithinEntitlement} would enforce, for
 * writes that check the limit inside the storage Durable Object instead of
 * before it.
 */
export async function readStorageBytesEntitlementLimit(input: {
	db: D1Database
	userId: OwnerId
	email: string | null | undefined
}): Promise<number> {
	const now = new Date()
	const entitlement = await withLiveLimitOverrides({
		db: input.db,
		orgId: input.userId,
		entitlement: getCachedUserEntitlement(input.db, {
			userId: input.userId,
			email: input.email,
		}),
		resource: 'storage_bytes',
		now,
	})
	return resolveEntitlementLimit(entitlement, 'storage_bytes', now)
}

export async function assertWithinStorageBytesEntitlement(input: {
	db: D1Database
	userId: OwnerId
	email: string | null | undefined
	requested?: number
	getCurrent?: () => Promise<number>
	/**
	 * UserMeter binding: required for the DO reserve path (non-getCurrent).
	 * Throws immediately if absent; omit only when passing getCurrent.
	 */
	env?: UserMeterEnv
}) {
	if (input.getCurrent) {
		await assertWithinEntitlement({
			db: input.db,
			userId: input.userId,
			email: input.email,
			resource: 'storage_bytes',
			requested: input.requested,
			getCurrent: input.getCurrent,
		})
		return
	}

	// DO-authoritative reserve path: env.USER_METER is required.
	if (!input.env || !userMeterNamespace(input.env)) {
		throw new Error(
			'assertWithinStorageBytesEntitlement requires env.USER_METER for the atomic reserve path.',
		)
	}

	// Preserve the plan-cache convention: limit resolution tolerates ~60s
	// staleness while the DO counter itself is always fresh.
	const entitlement = await getCachedUserEntitlement(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const plan = entitlement.plan
	const limit = resolveEntitlementLimit(entitlement, 'storage_bytes')
	const requested = Math.max(0, input.requested ?? 1)
	const updatedAt = new Date().toISOString()

	const meter = userMeterRpc({ env: input.env, userId: input.userId })

	for (let attempt = 0; attempt < storageBytesBootstrapMaxAttempts; attempt++) {
		const result = await meter.reserveStorageBytes({
			requested,
			limit,
			updatedAt,
		})

		if (result.outcome === 'needs_bootstrap') {
			if (
				!(await userAccountRowExists({ db: input.db, userId: input.userId }))
			) {
				// Synthetic context: no users row — cannot create a DO entry for a
				// non-existent account. Apply free-plan allow/deny without DO.
				const current = 0
				if (current + requested <= limit) return
				{
					const paths = await entitlementOrgPaths(input.db, input.userId)
					throw new EntitlementLimitError({
						resource: 'storage_bytes',
						plan,
						limit,
						current,
						...(paths.orgSlug ? { orgSlug: paths.orgSlug } : {}),
						upgradeHint: buildEntitlementUpgradeHint({
							resource: 'storage_bytes',
							plan,
							creditWallet: entitlement.creditWallet,
							billingPath: paths.billingPath,
							...(paths.usagePath ? { usagePath: paths.usagePath } : {}),
						}),
					})
				}
			}
			// Real owner with no DO row: lazy-enqueue a shared per-owner
			// physical reconcile (one SUM for concurrent cold callers), then
			// retry the reserve. Failures propagate — never zero-init after a
			// failed scan (that would under-enforce existing payload).
			await enqueueOwnerD1StorageReconcile({
				db: input.db,
				env: input.env,
				userId: input.userId,
				now: new Date(updatedAt),
				jobs: jobsStoreForOwnerStorageReconcile(
					input.db,
					input.env as Partial<Pick<Env, 'JOBS'>>,
				),
			})
			const afterReconcile = await meter.readStorageBytes()
			if (afterReconcile.outcome === 'needs_bootstrap') {
				throw new Error(
					'UserMeter storage bytes still need bootstrap after physical reconcile.',
				)
			}
			continue
		}

		if (!result.reserved) {
			const paths = await entitlementOrgPaths(input.db, input.userId)
			throw new EntitlementLimitError({
				resource: 'storage_bytes',
				plan,
				limit,
				current: result.bytes,
				...(paths.orgSlug ? { orgSlug: paths.orgSlug } : {}),
				upgradeHint: buildEntitlementUpgradeHint({
					resource: 'storage_bytes',
					plan,
					creditWallet: entitlement.creditWallet,
					billingPath: paths.billingPath,
					...(paths.usagePath ? { usagePath: paths.usagePath } : {}),
				}),
			})
		}

		return
	}

	throw new Error(
		'UserMeter storage bytes reserve still needs bootstrap after initialize.',
	)
}

export type AssertWithinEntitlementInput = {
	db: D1Database
	userId: OwnerId
	/**
	 * Real account email of the acting user. Plan lookup requires the email +
	 * stable-id pair; absent or unknown identities fail closed to `free`.
	 */
	email: string | null | undefined
	resource: EntitlementResource
	/** How many units the operation is about to consume. Defaults to 1. */
	requested?: number
	/**
	 * Override the built-in usage counter for this resource. Required for
	 * `concurrent_workflows` (pass RunLog reservation occupancy).
	 */
	getCurrent?: () => Promise<number>
	now?: Date
}

/**
 * The single enforcement helper. Every entitlement enforcement point calls
 * this and lets the thrown EntitlementLimitError propagate unchanged so the
 * error shape and user-facing message stay identical across MCP and UI
 * surfaces. Every resolved plan has finite numeric limits.
 */
export async function assertWithinEntitlement(
	input: AssertWithinEntitlementInput,
): Promise<void> {
	const now = input.now ?? new Date()
	// Cached plan resolution: quota limit lookup tolerates short-TTL
	// staleness; usage counters below stay fresh on every call.
	const entitlement = await withLiveLimitOverrides({
		db: input.db,
		orgId: input.userId,
		entitlement: getCachedUserEntitlement(input.db, {
			userId: input.userId,
			email: input.email,
		}),
		resource: input.resource,
		now,
	})
	const plan = entitlement.plan
	const limit = resolveEntitlementLimit(entitlement, input.resource, now)
	const requested = input.requested ?? 1
	const current = input.getCurrent
		? await input.getCurrent()
		: await readEntitlementResourceUsage({
				db: input.db,
				userId: input.userId,
				resource: input.resource,
				now,
			})
	if (current + requested > limit) {
		const paths = await entitlementOrgPaths(input.db, input.userId)
		throw new EntitlementLimitError({
			resource: input.resource,
			plan,
			limit,
			current,
			...(paths.orgSlug ? { orgSlug: paths.orgSlug } : {}),
			upgradeHint: buildEntitlementUpgradeHint({
				resource: input.resource,
				plan,
				creditWallet: entitlement.creditWallet,
				billingPath: paths.billingPath,
				...(paths.usagePath ? { usagePath: paths.usagePath } : {}),
				now,
			}),
		})
	}
}

export type ConsumeDailyEntitlementInput = {
	db: D1Database
	/** Must expose `USER_METER` (sole daily counter authority). */
	env: UserMeterEnv
	userId: OwnerId
	email: string | null | undefined
	resource: EntitlementResource
	now?: Date
	/** Org budget context for team orgs (defaults to personal org id = userId). */
	orgBudget?: OrgBudgetGateContext
}

/**
 * Atomically consume one daily entitlement unit via UserMeter, throwing
 * EntitlementLimitError when the plan limit would be exceeded. Cold keys
 * initialize at zero (concurrent-safe); warm path awaits only the DO RPC.
 * Daily counters live only in UserMeter (no D1 daily-counter table).
 */
export async function consumeDailyEntitlement(
	input: ConsumeDailyEntitlementInput,
): Promise<void> {
	const resource = assertDailyEntitlementResource(input.resource)
	if (resource === executeUniqueWorkersResource) {
		throw new Error(
			'execute_unique_workers_per_day counts unique workers; use consumeExecuteUniqueWorkerDay.',
		)
	}
	const window = await resolveDailyEntitlementWindow({ ...input, resource })
	const consumeInput = {
		resource,
		day: window.day,
		limit: window.limit,
		updatedAt: window.updatedAt,
		weekStart: window.weekStart,
		weekLimit: window.weekLimit,
	}
	const result = await withUserMeterCounterBootstrap({
		...input,
		resource,
		window,
		run: (meter) => meter.consume(consumeInput),
	})
	if (!result.consumed) {
		await throwDailyEntitlementDenial({ ...input, resource, window, result })
	}
}

export type ExecuteUniqueWorkerUsage = {
	used: number
	limit: number
	weekUsed: number | null
	weekLimit: number | null
}

export type ExecuteUniqueWorkerDayUsage = ExecuteUniqueWorkerUsage & {
	/** True when this call loads a new worker today and spent one unit. */
	created: boolean
}

/**
 * Current hosted execute usage without spending, for execute responses that
 * never reached the worker claim (refused or failed before load).
 */
export async function readExecuteUniqueWorkerUsage(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	email: string | null | undefined
	now?: Date
}): Promise<ExecuteUniqueWorkerUsage> {
	const resource = executeUniqueWorkersResource
	const now = input.now ?? new Date()
	const entitlement = await withLiveSeats({
		db: input.db,
		orgId: input.userId,
		entitlement: await withLiveLimitOverrides({
			db: input.db,
			orgId: input.userId,
			entitlement: getCachedUserEntitlement(input.db, {
				userId: input.userId,
				email: input.email,
			}),
			resource,
			now,
		}),
		resource,
	})
	const limit = resolveEntitlementLimit(entitlement, resource, now)
	const weekLimit = resolveWeeklyEntitlementLimit(entitlement, resource, now)
	const [used, weekUsed] = await Promise.all([
		readDailyEntitlementResourceUsage({
			env: input.env,
			userId: input.userId,
			resource,
			now,
		}),
		weekLimit === null
			? null
			: readWeeklyEntitlementResourceUsage({
					env: input.env,
					userId: input.userId,
					resource,
					now,
				}),
	])
	return { used, limit, weekUsed, weekLimit }
}

const executeUniqueWorkersResource =
	'execute_unique_workers_per_day' satisfies DailyEntitlementResource

/**
 * Hosted execute cap: spend one unit only when `workerId` is a new Dynamic
 * Worker for this org today (the unit Cloudflare bills). Repeats of code
 * already loaded today are free. Throws EntitlementLimitError when a new
 * worker would exceed the daily or weekly limit; the worker stays unclaimed.
 */
export async function consumeExecuteUniqueWorkerDay(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	email: string | null | undefined
	workerId: string
	now?: Date
	orgBudget?: OrgBudgetGateContext
}): Promise<ExecuteUniqueWorkerDayUsage> {
	const resource = executeUniqueWorkersResource
	const window = await resolveDailyEntitlementWindow({ ...input, resource })
	const result = await withUserMeterCounterBootstrap({
		...input,
		resource,
		window,
		run: (meter) =>
			meter.claimDynamicWorkerDayWithinLimit({
				workerId: input.workerId,
				resource,
				day: window.day,
				limit: window.limit,
				createdAt: window.updatedAt,
				weekStart: window.weekStart,
				weekLimit: window.weekLimit,
			}),
	})
	if (result.deniedWindow) {
		await throwDailyEntitlementDenial({ ...input, resource, window, result })
	}
	return {
		created: result.created,
		used: result.count,
		limit: window.limit,
		weekUsed: window.weekLimit === null ? null : (result.weekCount ?? 0),
		weekLimit: window.weekLimit,
	}
}

type DailyEntitlementWindow = {
	entitlement: UserEntitlement
	now: Date
	day: string
	updatedAt: string
	limit: number
	weekStart: string | undefined
	weekLimit: number | null
}

async function resolveDailyEntitlementWindow(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	email: string | null | undefined
	resource: DailyEntitlementResource
	now?: Date
	orgBudget?: OrgBudgetGateContext
}): Promise<DailyEntitlementWindow> {
	const resource = input.resource
	const now = input.now ?? new Date()
	// Cached plan resolution: this runs on every new execute worker and every
	// sandbox outbound fetch; the UserMeter call after it is the only
	// counter state that must be fresh. Overrides are read live in parallel.
	const cachedEntitlement = await withLiveLimitOverrides({
		db: input.db,
		orgId: input.userId,
		entitlement: getCachedUserEntitlement(input.db, {
			userId: input.userId,
			email: input.email,
		}),
		resource,
		now,
	})
	// Before the counter so a stopped attempt does not spend daily quota.
	const checkedEntitlement = isPastIncludeStopResource(resource)
		? await assertWithinPastIncludeCredits({
				db: input.db,
				env: input.env,
				userId: input.userId,
				entitlement: cachedEntitlement,
				now,
				orgBudget: input.orgBudget,
			})
		: cachedEntitlement
	const entitlement = await withLiveSeats({
		db: input.db,
		orgId: input.userId,
		entitlement: checkedEntitlement,
		resource,
	})
	const limit = resolveEntitlementLimit(entitlement, resource, now)
	const weekLimit = resolveWeeklyEntitlementLimit(entitlement, resource, now)
	return {
		entitlement,
		now,
		day: utcDayKey(now),
		updatedAt: now.toISOString(),
		limit,
		weekStart: weekLimit === null ? undefined : utcWeekStart(now),
		weekLimit,
	}
}

async function withUserMeterCounterBootstrap<
	T extends { outcome: 'ready' } | { outcome: 'needs_bootstrap' },
>(input: {
	env: UserMeterEnv
	userId: OwnerId
	resource: DailyEntitlementResource
	window: DailyEntitlementWindow
	run: (meter: ReturnType<typeof userMeterRpc>) => Promise<T>
}): Promise<Exclude<T, { outcome: 'needs_bootstrap' }>> {
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	let result = await input.run(meter)
	if (result.outcome === 'needs_bootstrap') {
		await ensureUserMeterCounterInitializedAtZero({
			env: input.env,
			userId: input.userId,
			resource: input.resource,
			day: input.window.day,
			updatedAt: input.window.updatedAt,
		})
		result = await input.run(meter)
		if (result.outcome === 'needs_bootstrap') {
			throw new Error(
				'UserMeter consume still needs bootstrap after initialize.',
			)
		}
	}
	return result as Exclude<T, { outcome: 'needs_bootstrap' }>
}

async function throwDailyEntitlementDenial(input: {
	db: D1Database
	userId: OwnerId
	resource: DailyEntitlementResource
	window: DailyEntitlementWindow
	result: { count: number; deniedWindow?: 'day' | 'week'; weekCount?: number }
}): Promise<never> {
	const { entitlement, now, limit, weekLimit } = input.window
	const paths = await entitlementOrgPaths(input.db, input.userId)
	const orgFields = paths.orgSlug ? { orgSlug: paths.orgSlug } : {}
	const upgradeHint = (window: 'day' | 'week') =>
		buildEntitlementUpgradeHint({
			resource: input.resource,
			plan: entitlement.plan,
			creditWallet: entitlement.creditWallet,
			billingPath: paths.billingPath,
			...(paths.usagePath ? { usagePath: paths.usagePath } : {}),
			window,
			now,
		})
	if (input.result.deniedWindow === 'week' && weekLimit !== null) {
		throw new EntitlementLimitError({
			resource: input.resource,
			plan: entitlement.plan,
			limit: weekLimit,
			current: input.result.weekCount ?? 0,
			window: 'week',
			...orgFields,
			upgradeHint: upgradeHint('week'),
			now,
		})
	}
	throw new EntitlementLimitError({
		resource: input.resource,
		plan: entitlement.plan,
		limit,
		current: input.result.count,
		...orgFields,
		upgradeHint: upgradeHint('day'),
		now,
	})
}

const cachedMonthlyComputeUsage =
	createEntitlementLookupCache<MonthlyComputeUsage>()

/**
 * Include → credits → stop for purchasable Pro: once this UTC month's
 * Worker compute or Rows read include is used up and the wallet is empty,
 * new compute stops until credits are added. Funded wallets pay past the
 * include; wallet-less plans keep their hard caps. `usage_rollups` refresh
 * hourly and the read shares the entitlement cache TTL, so the stop trails
 * usage by about an hour; a later top-up forgives that overshoot instead of
 * charging it. A stop is confirmed against an uncached entitlement so a
 * top-up in another isolate resumes work right away. Org budgets are
 * checked after the include stop. Returns the entitlement callers should
 * resolve limits from: the uncached one when the stop re-read it.
 */
async function assertWithinPastIncludeCredits(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	entitlement: UserEntitlement
	now: Date
	orgBudget?: OrgBudgetGateContext
}): Promise<UserEntitlement> {
	let entitlement = input.entitlement
	if (input.entitlement.creditWallet === 'empty') {
		const month = utcMonthKey(input.now)
		const usage = await cachedMonthlyComputeUsage.getOrCreate(
			input.db,
			`${input.userId}\n${month}`,
			async () =>
				await readMonthlyComputeUsage({
					db: input.db,
					stableUserId: input.userId,
					month,
				}),
		)
		const stop = resolvePastIncludeStop({
			plan: input.entitlement.plan,
			ladder: input.entitlement.ladder,
			creditWallet: input.entitlement.creditWallet,
			...usage,
			limitOverrides: input.entitlement.limitOverrides,
			now: input.now,
		})
		if (stop) {
			const fresh = await getUserEntitlement(input.db, {
				userId: input.userId,
				email: null,
			})
			if (fresh.creditWallet === 'empty') {
				throw new ComputeOverageLimitError({
					resource: stop.resource,
					plan: fresh.plan,
					limit: stop.limit,
					current: stop.current,
					creditsStatus: 'add_credits',
				})
			}
			entitlement = fresh
		}
	}
	const budget = orgBudgetFromGateContext(input.userId, input.orgBudget)
	await assertWithinOrgBudget({
		db: input.db,
		env: input.env,
		orgId: budget.orgId,
		orgSlug: budget.orgSlug,
		actorUserId: budget.actorUserId,
		automationSource: budget.automationSource,
		actorUsername: budget.actorUsername,
		estimatedDeltaMicroUsd: 0,
		now: input.now,
	})
	return entitlement
}

/**
 * The include → credits → stop gate for compute that has no daily counter:
 * hosted package app requests and realtime hooks. Counted entry points get
 * the same check inside {@link consumeDailyEntitlement}.
 */
export async function assertWithinComputeInclude(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	now?: Date
	orgBudget?: OrgBudgetGateContext
}) {
	const now = input.now ?? new Date()
	const cached = await getCachedUserEntitlement(input.db, {
		userId: input.userId,
		email: null,
	})
	// Only an empty wallet can stop here, so only it pays the live read of
	// the monthly cap overrides.
	const entitlement =
		cached.creditWallet === 'empty' && cached.limitOverrides !== undefined
			? {
					...cached,
					limitOverrides: await readActiveOrgLimitOverrides(
						input.db,
						input.userId,
						now,
					),
				}
			: cached
	await assertWithinPastIncludeCredits({
		db: input.db,
		env: input.env,
		userId: input.userId,
		entitlement,
		now,
		orgBudget: input.orgBudget,
	})
}

export { isBudgetLimitError }

export type RefundDailyEntitlementInput = {
	env: UserMeterEnv
	userId: OwnerId
	resource: EntitlementResource
	now?: Date
}

/**
 * Atomically refund one previously consumed daily entitlement unit in
 * UserMeter (floors at zero). Pass the same `now` (day key) as the matching
 * consume. Daily counters live only in UserMeter (no D1 daily-counter table).
 */
export async function refundDailyEntitlement(
	input: RefundDailyEntitlementInput,
): Promise<void> {
	const resource = assertDailyEntitlementResource(input.resource)
	const now = input.now ?? new Date()
	const day = utcDayKey(now)
	const updatedAt = now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	await meter.refund({
		resource,
		day,
		updatedAt,
	})
}
