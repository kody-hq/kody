import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	type AccountUsageComputeOverage,
	type AccountUsageStoryData,
} from '#universal/loader-data.ts'
import { type CreditWalletState, type PlanName } from '#universal/plans.ts'
import {
	accountActivityMetrics,
	includedComputeSummary,
	presentIncludedCompute,
	resolveCreditsAlarm,
	toAccountActivity,
	type AccountActivity,
	type AccountActivityMetric,
	type CreditsAlarmAutoRefill,
} from '#universal/usage-presentation.ts'
import {
	readCreditWallet,
	sumCreditAutoRefillCents,
} from '#worker/billing/credit-wallet.ts'

/** This UTC month's activity counts from the hourly `usage_rollups`. */
export async function readAccountActivity(input: {
	db: D1Database
	stableUserId: string
	month: string
}): Promise<AccountActivity> {
	const placeholders = accountActivityMetrics.map(() => '?').join(', ')
	const rows = await input.db
		.prepare(
			`SELECT metric, event_count
			 FROM usage_rollups
			 WHERE user_id = ?
				AND month = ?
				AND metric IN (${placeholders})`,
		)
		.bind(input.stableUserId, input.month, ...accountActivityMetrics)
		.all<{ metric: string; event_count: number }>()
	const counts: Partial<Record<AccountActivityMetric, number>> = {}
	for (const row of rows.results ?? []) {
		if (
			(accountActivityMetrics as ReadonlyArray<string>).includes(row.metric)
		) {
			counts[row.metric as AccountActivityMetric] = Number(row.event_count)
		}
	}
	return toAccountActivity({ month: input.month, counts })
}

/**
 * Activity, included compute, and the credits alarm on `/account/usage`,
 * told once above plan limits and the Credits section.
 */
export async function loadAccountUsageStory(input: {
	db: D1Database
	stableUserId: string
	plan: PlanName
	creditWallet: CreditWalletState
	canBuyCredits: boolean
	/** Stripe purchasable Pro; see {@link resolveCreditsAlarm}. */
	hasPaidProSubscription?: boolean
	computeOverage: AccountUsageComputeOverage | null
	now: Date
	/** Already-read wallet state; read here when omitted and a wallet exists. */
	wallet?: {
		balanceMicroUsd: number
		autoRefill: CreditsAlarmAutoRefill
	}
}): Promise<AccountUsageStoryData> {
	const month = utcMonthKey(input.now)
	const [activity, wallet] = await Promise.all([
		readAccountActivity({
			db: input.db,
			stableUserId: input.stableUserId,
			month,
		}),
		input.wallet ??
			(input.creditWallet === 'none'
				? null
				: readWalletForAlarm({
						db: input.db,
						stableUserId: input.stableUserId,
						month,
					})),
	])
	const includedCompute = input.computeOverage
		? presentIncludedCompute({
				meters: input.computeOverage.meters,
				plan: input.plan,
				creditWallet: input.creditWallet,
			})
		: []
	return {
		activity,
		includedCompute,
		includedComputeSummary: includedComputeSummary({
			plan: input.plan,
			creditWallet: input.creditWallet,
			meters: includedCompute,
		}),
		creditsAlarm: resolveCreditsAlarm({
			creditWallet: input.creditWallet,
			meters: includedCompute,
			balanceMicroUsd: wallet?.balanceMicroUsd ?? 0,
			canBuyCredits: input.canBuyCredits,
			hasPaidProSubscription: input.hasPaidProSubscription === true,
			autoRefill: wallet?.autoRefill ?? null,
		}),
	}
}

async function readWalletForAlarm(input: {
	db: D1Database
	stableUserId: string
	month: string
}) {
	const [wallet, refilledThisMonthCents] = await Promise.all([
		readCreditWallet(input.db, input.stableUserId),
		sumCreditAutoRefillCents({
			db: input.db,
			userId: input.stableUserId,
			month: input.month,
		}),
	])
	return {
		balanceMicroUsd: wallet.balanceMicroUsd,
		autoRefill: { ...wallet.autoRefill, refilledThisMonthCents },
	}
}
