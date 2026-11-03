/**
 * Hourly credit debit lane. Runs right after `usage_aggregation` recomputes
 * `usage_rollups`, so debits only ever read a freshly recomputed month.
 *
 * Candidates are every live org that holds a `credit_wallets` row, plus
 * every active gift/referral overlay period that still lacks a wallet row.
 * Team org wallets are keyed by org id. Personal org id equals
 * `stable_user_id`, and the keyset visits each id once. A missing wallet
 * reads as zero
 * balance and is backfilled (INSERT OR IGNORE) before settle, so the debit
 * walk never skips an overlay period and later funded debits still see the
 * row. Non-charging settle advances progress against at least the
 * purchasable Pro baseline (#2642).
 *
 * For every candidate, per UTC month (the prior month while its rollup still
 * settles, and the current month) and per debit meter:
 *
 * - billable units = usage above the include for the account's current
 *   plan (purchasable Pro includes when wallet-eligible).
 * - `credit_debit_progress.accounted_units` is how many of those units were
 *   already handled. The delta is priced at the cumulative debit rate
 *   (`creditDebitCostMicroUsd(next) - creditDebitCostMicroUsd(accounted)`).
 * - A funded purchasable-Pro wallet is debited for the delta. The balance
 *   can dip below $0 by up to one hour of usage past the include; after
 *   that, past-include runs stop until a top-up covers it
 *   (include → credits → stop, enforced in `consumeDailyEntitlement`).
 * - Every other wallet (empty, or not eligible) advances progress without
 *   a debit. An empty wallet only gets here through the hour-scale lag
 *   before the stop applies; that overshoot and wallet-less usage are never
 *   charged, including by a later top-up.
 *
 * Debit ledger ids are deterministic per (user, month, meter, starting
 * units), so an overlapping run collides on the primary key and the whole
 * batch rolls back instead of charging twice.
 *
 * After debits, the lane runs auto-refill and the low-balance notice. Each
 * run is bounded; `credit_debit_cursor` keeps the keyset position so the
 * next run continues past the last wallet this one reached.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { computeMonthlyOverage } from '#universal/compute-overage.ts'
import {
	creditDebitCostMicroUsd,
	creditDebitMeters,
	crossedCreditLowBalance,
	type CreditDebitMeter,
} from '#universal/credits.ts'
import type { UserEntitlement } from '#universal/plans.ts'
import {
	isPayingForCreditsPro,
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { runCreditAutoRefill } from './credit-auto-refill.ts'
import { sendCreditLowBalanceEmail } from '#app/user-account-emails.ts'
import { sendToOrgBillingRecipients } from './org-billing-emails.ts'
import { creditDebitMonths } from './credit-wallet.ts'
import { readMonthlyComputeUsage } from './compute-overage-usage.ts'
import { syncOrgBudgetSpendFromCreditLedger } from '#worker/entitlements/budget-gate.ts'

export const creditDebitBatchSize = 50
export const creditDebitMaxBatchesPerRun = 20

type CreditDebitCandidateRow = UserEntitlementRow & {
	user_id: OwnerId
	email: string
	stripe_customer_id: string | null
	balance_micro_usd: number
	auto_refill_enabled: number
	notify_low_balance: number
}

export type CreditDebitMonthOutcome = {
	month: string
	debitedMicroUsd: number
	forgivenUnits: Record<CreditDebitMeter, number>
}

export type CreditDebitRunResult = {
	scanned: number
	debitedUsers: number
	debitedMicroUsd: number
	autoRefilled: number
	failed: number
	done: boolean
}

export async function runCreditDebits(input: {
	env: Env
	now: Date
}): Promise<CreditDebitRunResult> {
	const db = input.env.APP_DB
	const months = creditDebitMonths(input.now)
	let startAfter = await readCreditDebitCursor(db)
	let scanned = 0
	let debitedUsers = 0
	let debitedMicroUsd = 0
	let autoRefilled = 0
	let failed = 0
	let done = false
	for (let batch = 0; batch < creditDebitMaxBatchesPerRun; batch += 1) {
		const rows = await listCreditDebitCandidates({
			db,
			startAfter,
			now: input.now,
		})
		for (const row of rows) {
			try {
				const outcome = await debitOneWallet({
					env: input.env,
					row,
					months,
					now: input.now,
				})
				if (outcome.debitedMicroUsd > 0) {
					debitedUsers += 1
					debitedMicroUsd += outcome.debitedMicroUsd
				}
				if (outcome.autoRefilled) autoRefilled += 1
			} catch (error) {
				failed += 1
				console.error('credit_debit_failed', {
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		scanned += rows.length
		const last = rows.at(-1)
		if (!last || rows.length < creditDebitBatchSize) {
			done = true
			break
		}
		startAfter = last.user_id
	}
	// Resume where this bounded run stopped; wrap once the tail is reached.
	await writeCreditDebitCursor({
		db,
		position: done ? '' : startAfter,
		now: input.now,
	})
	return { scanned, debitedUsers, debitedMicroUsd, autoRefilled, failed, done }
}

async function readCreditDebitCursor(db: D1Database): Promise<string> {
	const row = await db
		.prepare(`SELECT position FROM credit_debit_cursor WHERE singleton = 1`)
		.first<{ position: string }>()
	return row?.position ?? ''
}

async function writeCreditDebitCursor(input: {
	db: D1Database
	position: string
	now: Date
}) {
	await input.db
		.prepare(
			`INSERT INTO credit_debit_cursor (singleton, position, updated_at)
			 VALUES (1, ?, ?)
			 ON CONFLICT (singleton) DO UPDATE SET
				position = excluded.position,
				updated_at = excluded.updated_at`,
		)
		.bind(input.position, input.now.toISOString())
		.run()
}

/**
 * Wallet holders plus active gift/referral overlay periods. Every live org
 * with a `credit_wallets` row is a candidate (personal or team). Overlay orgs
 * without a wallet still appear (balance coalesced to 0) so non-charging
 * settle can leave a high-water mark before a later funded return. `UNION`
 * keeps one row per org id. Exported for tests.
 */
export async function listCreditDebitCandidates(input: {
	db: D1Database
	startAfter: string
	now: Date
}): Promise<Array<CreditDebitCandidateRow>> {
	const nowIso = input.now.toISOString()
	const rows = await input.db
		.prepare(
			`SELECT ids.id AS user_id,
				COALESCE(w.balance_micro_usd, 0) AS balance_micro_usd,
				COALESCE(w.auto_refill_enabled, 0) AS auto_refill_enabled,
				COALESCE(w.notify_low_balance, 1) AS notify_low_balance,
				COALESCE(u.email, '') AS email,
				o.stripe_customer_id AS stripe_customer_id,
				${userEntitlementColumnsSql('o')}
			 FROM (
				SELECT w.user_id AS id
				FROM credit_wallets w
				INNER JOIN orgs live_org
					ON live_org.id = w.user_id
				   AND live_org.deleting_at IS NULL${andLiveDeletedAtSql('live_org')}
				WHERE w.user_id > ?
				UNION
				SELECT live_org.id AS id
				FROM orgs live_org
				WHERE live_org.deleting_at IS NULL${andLiveDeletedAtSql('live_org')}
				  AND live_org.id > ?
				  AND (
					live_org.second_agent_standard_gift_expires_at > ?
					OR live_org.referral_standard_credit_expires_at > ?
				  )
			 ) ids
			 INNER JOIN orgs o
				ON o.id = ids.id
			   AND o.deleting_at IS NULL${andLiveDeletedAtSql('o')}
			 LEFT JOIN users u
				ON u.stable_user_id = ids.id
			   AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
			 LEFT JOIN credit_wallets w ON w.user_id = ids.id
			 ORDER BY ids.id
			 LIMIT ?`,
		)
		.bind(
			input.startAfter,
			input.startAfter,
			nowIso,
			nowIso,
			creditDebitBatchSize,
		)
		.all<CreditDebitCandidateRow>()
	return rows.results ?? []
}

/**
 * Ensure a zero-balance wallet row exists for this user. Overlay periods
 * that never bought credits still need the row so later debit scans and
 * funded settles see them. Does not forgive usage — settle owns progress.
 */
export async function backfillCreditWalletRow(input: {
	db: D1Database
	userId: OwnerId
	now: Date
}): Promise<void> {
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
			 VALUES (?, ?, ?)`,
		)
		.bind(input.userId, nowIso, nowIso)
		.run()
}

async function debitOneWallet(input: {
	env: Env
	row: CreditDebitCandidateRow
	months: ReadonlyArray<string>
	now: Date
}): Promise<{ debitedMicroUsd: number; autoRefilled: boolean }> {
	const db = input.env.APP_DB
	const userId = input.row.user_id
	await backfillCreditWalletRow({ db, userId, now: input.now })
	const entitlement = await resolveUserEntitlementFromRow({
		db,
		stableUserId: userId,
		row: input.row,
		now: input.now,
	})
	const previousBalance = Number(input.row.balance_micro_usd)
	let debitedMicroUsd = 0
	for (const month of input.months) {
		const outcome = await settleCreditDebitMonth({
			db,
			env: input.env,
			userId,
			entitlement,
			month,
			now: input.now,
		})
		debitedMicroUsd += outcome.debitedMicroUsd
	}
	if (entitlement.creditWallet === 'none') {
		return { debitedMicroUsd, autoRefilled: false }
	}
	const nextBalance = previousBalance - debitedMicroUsd
	// Gift and referral Pro overlays are not wallet-eligible (retired Pro
	// ceilings). Only paying Pro auto-charges.
	const autoRefill = isPayingForCreditsPro(input.row)
		? await runCreditAutoRefill({
				env: input.env,
				userId,
				email: input.row.email,
				stripeCustomerId: input.row.stripe_customer_id,
				now: input.now,
			})
		: 'skipped'
	if (
		Number(input.row.notify_low_balance) === 1 &&
		crossedCreditLowBalance({
			previousBalanceMicroUsd: previousBalance,
			nextBalanceMicroUsd: nextBalance,
			autoRefillEnabled: Number(input.row.auto_refill_enabled) === 1,
		})
	) {
		await sendToOrgBillingRecipients({
			db: input.env.APP_DB,
			orgId: userId,
			sendOne: async (recipient) => {
				await sendCreditLowBalanceEmail({
					env: input.env,
					email: recipient.email,
					userId: recipient.userId,
					balanceMicroUsd: nextBalance,
					now: input.now,
				})
			},
		}).catch((error: unknown) => {
			console.warn('credit-low-balance-email-failed', error)
		})
	}
	return { debitedMicroUsd, autoRefilled: autoRefill === 'charged' }
}

type ProgressRow = { meter: string; accounted_units: number }

/**
 * Settle one (user, month): debit the funded wallet for newly billable
 * units, or advance progress without a charge. Non-charging settlement
 * advances progress against at least the purchasable Pro debit baseline
 * so a later funded return cannot back-charge usage from a larger include
 * (gift overlay, retired Pro). Exported for tests.
 */
export async function settleCreditDebitMonth(input: {
	db: D1Database
	env: Env
	userId: OwnerId
	entitlement: UserEntitlement
	month: string
	now: Date
}): Promise<CreditDebitMonthOutcome> {
	const usage = await readMonthlyComputeUsage({
		db: input.db,
		stableUserId: input.userId,
		month: input.month,
	})
	const overage = computeMonthlyOverage({
		plan: input.entitlement.plan,
		ladder: input.entitlement.ladder,
		creditWallet: input.entitlement.creditWallet,
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	const purchasableProDebitBaseline = computeMonthlyOverage({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'funded',
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	const charge = input.entitlement.creditWallet === 'funded'
	// When not charging, advance progress against at least the purchasable
	// Pro debit baseline. Gift/retired Pro ceilings are larger than that
	// baseline; without this, usage between 350 and 2,000 UWD would leave
	// progress behind and get back-charged on a later funded return. Empty
	// purchasable Pro already sits on that baseline.
	const progressOverage = charge
		? overage
		: {
				billableUniqueWorkerDays: Math.max(
					overage.billableUniqueWorkerDays,
					purchasableProDebitBaseline.billableUniqueWorkerDays,
				),
				billableDurableObjectRowsRead: Math.max(
					overage.billableDurableObjectRowsRead,
					purchasableProDebitBaseline.billableDurableObjectRowsRead,
				),
			}
	const billable: Record<CreditDebitMeter, number> = {
		unique_worker_days: progressOverage.billableUniqueWorkerDays,
		durable_object_rows_read: progressOverage.billableDurableObjectRowsRead,
	}
	const progressRows = await input.db
		.prepare(
			`SELECT meter, accounted_units FROM credit_debit_progress
			 WHERE user_id = ? AND month = ?`,
		)
		.bind(input.userId, input.month)
		.all<ProgressRow>()
	const accounted = new Map(
		(progressRows.results ?? []).map((row) => [
			row.meter,
			Number(row.accounted_units),
		]),
	)
	const nowIso = input.now.toISOString()
	const statements: Array<D1PreparedStatement> = []
	const forgivenUnits: Record<CreditDebitMeter, number> = {
		unique_worker_days: 0,
		durable_object_rows_read: 0,
	}
	let debitedMicroUsd = 0
	for (const meter of creditDebitMeters) {
		const from = accounted.get(meter) ?? 0
		const next = billable[meter]
		if (next <= from) continue
		if (charge) {
			const cost =
				creditDebitCostMicroUsd(meter, next) -
				creditDebitCostMicroUsd(meter, from)
			if (cost > 0) {
				debitedMicroUsd += cost
				statements.push(
					input.db
						.prepare(
							`INSERT INTO credit_ledger_entries
								(id, user_id, kind, amount_micro_usd, meter, month, units, created_at)
							 VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)`,
						)
						.bind(
							`debit:${input.userId}:${input.month}:${meter}:${from}`,
							input.userId,
							-cost,
							meter,
							input.month,
							next - from,
							nowIso,
						),
				)
			}
		} else {
			forgivenUnits[meter] = next - from
		}
		statements.push(
			input.db
				.prepare(
					`INSERT INTO credit_debit_progress
						(user_id, month, meter, accounted_units, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT (user_id, month, meter) DO UPDATE SET
						accounted_units = MAX(accounted_units, excluded.accounted_units),
						updated_at = excluded.updated_at`,
				)
				.bind(input.userId, input.month, meter, next, nowIso),
		)
	}
	if (debitedMicroUsd > 0) {
		statements.push(
			input.db
				.prepare(
					`UPDATE credit_wallets
					 SET balance_micro_usd = balance_micro_usd - ?, updated_at = ?
					 WHERE user_id = ?`,
				)
				.bind(debitedMicroUsd, nowIso, input.userId),
		)
	}
	let settledDebitedMicroUsd = debitedMicroUsd
	let batchCommitted = true
	if (statements.length > 0) {
		try {
			await input.db.batch(statements)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (!/UNIQUE constraint failed/i.test(message)) throw error
			// An overlapping run already settled from this starting point.
			settledDebitedMicroUsd = 0
			batchCommitted = false
		}
	}
	// Funded and empty wallets replay budget MTD from committed ledger
	// debits (idempotent absolute replace). Empty must still run: the debit
	// that hit $0 is the one most likely to need recovery, and the next
	// hourly settle would otherwise skip until a later top-up. Free/`none`
	// never debit, so skip those.
	if (input.entitlement.creditWallet !== 'none') {
		try {
			await syncOrgBudgetSpendFromCreditLedger({
				db: input.db,
				env: input.env,
				orgId: input.userId,
				month: input.month,
				includes: [
					{
						meter: 'unique_worker_days',
						include: overage.includedUniqueWorkerDays,
					},
					{
						meter: 'durable_object_rows_read',
						include: overage.includedDurableObjectRowsRead,
					},
				],
				now: input.now,
			})
		} catch (error) {
			console.error('org-budget-spend-sync-failed', {
				orgId: input.userId,
				month: input.month,
				debitedMicroUsd: settledDebitedMicroUsd,
				error,
			})
			// Debit already committed; next hourly settle retries the sync.
		}
	}
	return {
		month: input.month,
		debitedMicroUsd: settledDebitedMicroUsd,
		forgivenUnits: batchCommitted
			? forgivenUnits
			: {
					unique_worker_days: 0,
					durable_object_rows_read: 0,
				},
	}
}
