import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildBudgetSpendActorWeights,
	type BudgetSpendAttributionInclude,
} from '#universal/budget-spend-attribution.ts'
import { creditDebitMeters, type CreditDebitMeter } from '#universal/credits.ts'
import {
	backgroundRunBilledActor,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import { type TransactionalEmailEnv } from '#app/email/sender-config.ts'
import { sendBudgetHitEmail } from '#worker/billing/org-budget-hit-emails.ts'
import {
	readOrgBudgetSettings,
	readUserBudgetMicroUsd,
	resolveEffectiveUserBudgetMicroUsd,
} from '#worker/orgs/billing.ts'
import { BudgetLimitError, isBudgetLimitError } from './errors.ts'
import {
	checkUserMeterBudgetAndRecord,
	type UserMeterEnv,
	userMeterRpc,
} from './user-meter-client.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

type OrgBudgetHitEmailEnv = Pick<
	Env,
	| 'BUNDLE_ARTIFACTS_KV'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
> &
	TransactionalEmailEnv

export type OrgBudgetGateContext = {
	orgId: OwnerId
	orgSlug?: string | null
	actorUserId?: string | null
	actorUsername?: string | null
	automationSource?: string | null
}

/** Missing or deleted org rows skip the gate. Query errors propagate so a D1 fault never disables budget enforcement. */
async function orgBudgetEnforcementAvailable(
	db: D1Database,
	orgId: OwnerId,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM orgs WHERE id = ?${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(orgId)
		.first<{ ok: number }>()
	return row != null
}

async function loadBudgetLimits(input: {
	db: D1Database
	orgId: OwnerId
	actorUserId: string | null
}): Promise<{
	userBudgetMicroUsd: number | null
	automationBudgetMicroUsd: number | null
}> {
	const settings = await readOrgBudgetSettings(input.db, input.orgId)
	const individual =
		input.actorUserId == null
			? null
			: await readUserBudgetMicroUsd(input.db, input.orgId, input.actorUserId)
	return {
		userBudgetMicroUsd: resolveEffectiveUserBudgetMicroUsd({
			individualBudget: individual,
			orgDefaultBudget: settings.defaultUserBudgetMicroUsd,
		}),
		automationBudgetMicroUsd: settings.automationBudgetMicroUsd,
	}
}

function orgSlugLabel(orgSlug: string | null | undefined) {
	const trimmed = orgSlug?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : 'org'
}

/**
 * Real-time org budget gate backed by the org-scoped UserMeter durable object
 * (name key is org id; personal org ids match the owner user id).
 */
function notifyBudgetHitFireAndForget(input: {
	env: UserMeterEnv & OrgBudgetHitEmailEnv
	db: D1Database
	orgId: OwnerId
	actorUserId: string | null
	budgetError: BudgetLimitError
	now?: Date
}) {
	void sendBudgetHitEmail({
		env: input.env,
		db: input.db,
		orgId: input.orgId,
		details: input.budgetError.details,
		actorUserId: input.actorUserId,
		now: input.now,
	}).catch((error: unknown) => {
		console.warn('org-budget-hit-email-failed', error)
	})
}

export async function assertWithinOrgBudget(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: OwnerId
	orgSlug?: string | null
	actorUserId: string | null
	automationSource: string | null
	actorUsername?: string | null
	estimatedDeltaMicroUsd: number
	now?: Date
}): Promise<void> {
	if (!(await orgBudgetEnforcementAvailable(input.db, input.orgId))) {
		return
	}
	const actorUserId = input.actorUserId
	const isAutomation = actorUserId == null && input.automationSource != null
	const limits = await loadBudgetLimits({
		db: input.db,
		orgId: input.orgId,
		actorUserId: isAutomation ? null : actorUserId,
	})
	const userBudget = isAutomation ? null : limits.userBudgetMicroUsd
	const automationBudget = isAutomation ? limits.automationBudgetMicroUsd : null
	if (userBudget == null && automationBudget == null) {
		return
	}
	const month = utcMonthKey(input.now ?? new Date())
	try {
		await checkUserMeterBudgetAndRecord({
			env: input.env,
			userId: input.orgId,
			check: {
				month,
				actorUserId: isAutomation ? null : actorUserId,
				automationSource: input.automationSource,
				deltaMicroUsd: input.estimatedDeltaMicroUsd,
				userBudgetMicroUsd: userBudget,
				automationBudgetMicroUsd: automationBudget,
				actorUsername: input.actorUsername,
				orgSlug: orgSlugLabel(input.orgSlug),
			},
		})
	} catch (error) {
		if (isBudgetLimitError(error)) {
			notifyBudgetHitFireAndForget({
				env: input.env as UserMeterEnv & OrgBudgetHitEmailEnv,
				db: input.db,
				orgId: input.orgId,
				actorUserId: isAutomation ? null : actorUserId,
				budgetError: error,
				now: input.now,
			})
		}
		throw error
	}
}

/** Whether MTD budget counters should move for this UTC month (live gate month only). */
export function shouldMutateBudgetMtdForMonth(
	month: string,
	now: Date,
): boolean {
	const current = utcMonthKey(now)
	return month === current
}

/**
 * Map a background run (job, webhook, subscription) to its org budget gate
 * context. Enablement runs and inherited runs bill their person; legacy
 * Automation bills the org's automation budget.
 */
export function orgBudgetForJobExecution(input: {
	orgId: OwnerId
	orgSlug: string | null
	source: RequestSource
}): OrgBudgetGateContext {
	const actor = backgroundRunBilledActor(input.source)
	if (actor?.userId) {
		return {
			orgId: input.orgId,
			orgSlug: input.orgSlug,
			actorUserId: actor.userId,
			actorUsername: actor.username ?? null,
		}
	}
	const automationSource =
		input.source.kind === 'schedule'
			? 'schedule'
			: input.source.kind === 'webhook'
				? 'webhook'
				: input.source.kind === 'inbound-email'
					? 'email'
					: input.source.kind === 'platform-event'
						? 'event'
						: 'schedule'
	return {
		orgId: input.orgId,
		orgSlug: input.orgSlug,
		automationSource,
		actorUserId: null,
	}
}

/** Record metered spend without re-checking limits (ledger reconciliation). */
export async function recordOrgBudgetSpend(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: OwnerId
	orgSlug?: string | null
	actorUserId: string | null
	automationSource: string | null
	deltaMicroUsd: number
	now?: Date
	/** Defaults to the UTC month of `now`; past months skip MTD mutation. */
	month?: string
}): Promise<void> {
	const delta = Math.max(0, Math.floor(Number(input.deltaMicroUsd)))
	if (delta === 0) return
	if (!(await orgBudgetEnforcementAvailable(input.db, input.orgId))) {
		return
	}
	const now = input.now ?? new Date()
	const month = input.month ?? utcMonthKey(now)
	if (!shouldMutateBudgetMtdForMonth(month, now)) {
		console.info('org_budget_spend_skip_past_month', {
			orgId: input.orgId,
			month,
			currentMonth: utcMonthKey(now),
		})
		return
	}
	const actorUserId = input.actorUserId
	const isAutomation = actorUserId == null && input.automationSource != null
	await checkUserMeterBudgetAndRecord({
		env: input.env,
		userId: input.orgId,
		check: {
			month,
			actorUserId: isAutomation ? null : actorUserId,
			automationSource: input.automationSource,
			deltaMicroUsd: delta,
			userBudgetMicroUsd: null,
			automationBudgetMicroUsd: null,
			orgSlug: orgSlugLabel(input.orgSlug),
		},
	})
}

export function orgBudgetFromGateContext(
	userId: OwnerId,
	context?: OrgBudgetGateContext | null,
): Required<
	Pick<
		OrgBudgetGateContext,
		'orgId' | 'orgSlug' | 'actorUserId' | 'actorUsername' | 'automationSource'
	>
> {
	return {
		orgId: context?.orgId ?? userId,
		orgSlug: context?.orgSlug ?? null,
		actorUserId: context?.automationSource
			? null
			: (context?.actorUserId ?? userId),
		actorUsername: context?.actorUsername ?? null,
		automationSource: context?.automationSource ?? null,
	}
}

type AttributionSpendShare = {
	actorUserId: string | null
	automationSource: string | null
	weight: number
}

/**
 * After a funded credit debit, attribute the spent micro-USD into org budget
 * MTD counters. The real-time gate only checks (delta 0); settlement is what
 * advances spend so member/automation budgets can block later work.
 *
 * Prefer {@link syncOrgBudgetSpendFromCreditLedger}: it recomputes absolute
 * MTD from committed ledger debits (idempotent recovery). This incremental
 * helper remains for tests and one-shot attribution of a known delta.
 *
 * Splits by overage-only `usage_attribution_daily` actor weights when present;
 * otherwise attributes the debit to the org billing id as the member actor
 * (personal-org soak: org id equals the owner user id).
 */
export async function recordOrgBudgetSpendAfterCreditDebit(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: OwnerId
	month: string
	debitedMicroUsd: number
	includes?: ReadonlyArray<BudgetSpendAttributionInclude>
	now?: Date
}): Promise<void> {
	const debit = Math.max(0, Math.floor(Number(input.debitedMicroUsd)))
	if (debit === 0) return
	const now = input.now ?? new Date()
	if (!shouldMutateBudgetMtdForMonth(input.month, now)) {
		return
	}
	const shares = await loadBudgetSpendShares({
		db: input.db,
		orgId: input.orgId,
		month: input.month,
		includes: input.includes,
	})
	const totalWeight = shares.reduce((sum, share) => sum + share.weight, 0)
	if (totalWeight <= 0 || shares.length === 0) {
		await recordOrgBudgetSpend({
			db: input.db,
			env: input.env,
			orgId: input.orgId,
			actorUserId: input.orgId,
			automationSource: null,
			deltaMicroUsd: debit,
			now,
			month: input.month,
		})
		return
	}
	let allocated = 0
	for (let index = 0; index < shares.length; index += 1) {
		const share = shares[index]!
		const isLast = index === shares.length - 1
		const slice = isLast
			? debit - allocated
			: Math.floor((debit * share.weight) / totalWeight)
		allocated += slice
		if (slice <= 0) continue
		await recordOrgBudgetSpend({
			db: input.db,
			env: input.env,
			orgId: input.orgId,
			actorUserId: share.actorUserId,
			automationSource: share.automationSource,
			deltaMicroUsd: slice,
			now,
			month: input.month,
		})
	}
}

/**
 * Idempotent org budget MTD sync from committed `credit_ledger_entries`
 * debits. Uses UserMeter `replaceBudgetSpendFromLedger` (absolute replace)
 * so a failed post-debit write is repaired on the next settle without
 * double-counting. Source of truth is the ledger; attribution weights are
 * overage-only.
 */
export async function syncOrgBudgetSpendFromCreditLedger(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: OwnerId
	month: string
	includes?: ReadonlyArray<BudgetSpendAttributionInclude>
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	if (!shouldMutateBudgetMtdForMonth(input.month, now)) {
		return
	}
	if (!(await orgBudgetEnforcementAvailable(input.db, input.orgId))) {
		return
	}
	const totalDebited = await sumOrgCreditDebitMicroUsd({
		db: input.db,
		orgId: input.orgId,
		month: input.month,
	})
	if (totalDebited <= 0) return

	const shares = await loadBudgetSpendShares({
		db: input.db,
		orgId: input.orgId,
		month: input.month,
		includes: input.includes,
	})
	const totalWeight = shares.reduce((sum, share) => sum + share.weight, 0)
	const users: Record<string, number> = {}
	let automation = 0
	if (totalWeight <= 0 || shares.length === 0) {
		users[input.orgId] = totalDebited
	} else {
		let allocated = 0
		for (let index = 0; index < shares.length; index += 1) {
			const share = shares[index]!
			const isLast = index === shares.length - 1
			const slice = isLast
				? totalDebited - allocated
				: Math.floor((totalDebited * share.weight) / totalWeight)
			allocated += slice
			if (slice <= 0) continue
			if (share.automationSource != null) {
				automation += slice
			} else if (share.actorUserId != null) {
				users[share.actorUserId] = (users[share.actorUserId] ?? 0) + slice
			}
		}
	}

	const meter = userMeterRpc({ env: input.env, userId: input.orgId })
	await meter.replaceBudgetSpendFromLedger({
		month: input.month,
		users,
		automation,
	})
}

async function sumOrgCreditDebitMicroUsd(input: {
	db: D1Database
	orgId: OwnerId
	month: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT COALESCE(SUM(-amount_micro_usd), 0) AS total
			 FROM credit_ledger_entries
			 WHERE user_id = ?
			   AND month = ?
			   AND kind = 'debit'`,
		)
		.bind(input.orgId, input.month)
		.first<{ total: number }>()
	const total = Math.floor(Number(row?.total ?? 0))
	return Number.isFinite(total) && total > 0 ? total : 0
}

async function loadBudgetSpendShares(input: {
	db: D1Database
	orgId: OwnerId
	month: string
	includes?: ReadonlyArray<BudgetSpendAttributionInclude>
}): Promise<Array<AttributionSpendShare>> {
	const monthPrefix = `${input.month}-`
	const meterList = creditDebitMeters.map((meter) => `'${meter}'`).join(', ')
	try {
		const { results } = await input.db
			.prepare(
				`SELECT
					day,
					meter,
					COALESCE(actor_user_id, '') AS actor_user_id,
					COALESCE(automation_source, '') AS automation_source,
					SUM(units) AS units
				 FROM usage_attribution_daily
				 WHERE user_id = ?
				   AND day >= ?
				   AND day < ?
				   AND meter IN (${meterList})
				 GROUP BY day, meter,
					COALESCE(actor_user_id, ''),
					COALESCE(automation_source, '')`,
			)
			.bind(
				input.orgId,
				`${monthPrefix}01`,
				// Exclusive upper bound: first day of next month (month is YYYY-MM).
				nextUtcMonthDay(input.month),
			)
			.all<{
				day: string
				meter: string
				actor_user_id: string
				automation_source: string
				units: number
			}>()
		const dailyUnits = []
		for (const row of results ?? []) {
			const meter = asCreditDebitMeter(row.meter)
			if (!meter) continue
			const units = Number(row.units)
			if (!Number.isFinite(units) || units <= 0) continue
			dailyUnits.push({
				day: row.day,
				meter,
				actorUserId: row.actor_user_id,
				automationSource: row.automation_source,
				units,
			})
		}
		const includes =
			input.includes ??
			creditDebitMeters.map((meter) => ({ meter, include: 0 }))
		return buildBudgetSpendActorWeights({ dailyUnits, includes })
	} catch (error) {
		console.error('org-budget-spend-shares-failed', {
			orgId: input.orgId,
			month: input.month,
			error,
		})
		throw error
	}
}

function asCreditDebitMeter(meter: string): CreditDebitMeter | null {
	return (creditDebitMeters as ReadonlyArray<string>).includes(meter)
		? (meter as CreditDebitMeter)
		: null
}

function nextUtcMonthDay(month: string): string {
	const [yearText, monthText] = month.split('-')
	const year = Number(yearText)
	const monthIndex = Number(monthText)
	if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
		return `${month}-32`
	}
	if (monthIndex >= 12) {
		return `${year + 1}-01-01`
	}
	return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`
}

export { BudgetLimitError }
