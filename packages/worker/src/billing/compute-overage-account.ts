import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	buildComputeOverageHowToReduce,
	computeMonthlyOverage,
	computeOverageIncludePercent,
	computeOverageResourceVisibility,
	computeOverageWarningResourceLabels,
	isCustomerFacingComputeMeter,
	resolveComputeIncludeCreditsStatus,
	resolvePastIncludeStopLimits,
	type ComputeOverageWarningResource,
} from '#universal/compute-overage.ts'
import type {
	CreditWalletState,
	EntitlementLadder,
	LimitOverride,
	PlanName,
} from '#universal/plans.ts'
import type { AccountUsageComputeOverage } from '#universal/loader-data.ts'
import { computeIncludeWarningPutsAccessAtRisk } from '#universal/usage-presentation.ts'
import { readMonthlyComputeUsage } from './compute-overage-usage.ts'

export type ComputeOverageUsageRow = {
	resource: ComputeOverageWarningResource
	label: string
	group: 'monthly'
	kind: 'counter'
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number
	overEightyPercent: boolean
}

export async function readAccountComputeOverage(input: {
	db: D1Database
	stableUserId: string
	plan: PlanName
	ladder: EntitlementLadder
	creditWallet: CreditWalletState
	limitOverrides?: ReadonlyArray<LimitOverride>
	now: Date
}): Promise<AccountUsageComputeOverage> {
	const month = utcMonthKey(input.now)
	const usage = await readMonthlyComputeUsage({
		db: input.db,
		stableUserId: input.stableUserId,
		month,
	})
	const overage = computeMonthlyOverage({
		plan: input.plan,
		ladder: input.ladder,
		creditWallet: input.creditWallet,
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	// An empty wallet is never debited, so its include is where runs stop
	// (raised by a monthly override); a funded wallet pays past the plan
	// include.
	const stopAt =
		input.creditWallet === 'empty' ? resolvePastIncludeStopLimits(input) : null
	// Both debit meters are customer-facing (Worker compute + Rows read).
	const meters = [
		toComputeMeter({
			resource: 'unique_worker_days',
			current: usage.uniqueWorkerDays,
			include: stopAt?.unique_worker_days ?? overage.includedUniqueWorkerDays,
			plan: input.plan,
			creditWallet: input.creditWallet,
		}),
		toComputeMeter({
			resource: 'durable_object_rows_read',
			current: usage.durableObjectRowsRead,
			include:
				stopAt?.durable_object_rows_read ??
				overage.includedDurableObjectRowsRead,
			plan: input.plan,
			creditWallet: input.creditWallet,
		}),
	].filter((meter) => isCustomerFacingComputeMeter(meter.resource))
	return {
		meters,
		creditWallet: input.creditWallet,
		creditsStatus: resolveComputeIncludeCreditsStatus({
			plan: input.plan,
			creditWallet: input.creditWallet,
			pastInclude: meters.some((meter) => meter.percentOfLimit > 1),
		}),
		creditsCostMicroUsd: overage.creditsCostMicroUsd,
	}
}

export function toComputeOverageUsageRows(
	overage: AccountUsageComputeOverage,
): Array<ComputeOverageUsageRow> {
	return overage.meters.map((meter) => ({
		resource: meter.resource,
		label: meter.label,
		group: 'monthly',
		kind: 'counter',
		whatCounts: meter.whatCounts,
		howToReduce: meter.howToReduce,
		current: meter.current,
		limit: meter.include,
		percentOfLimit: meter.percentOfLimit,
		overEightyPercent: meter.overEightyPercent,
	}))
}

/**
 * Monthly include rows for `usageGet` warnings: only when crossing the
 * include would stop runs (see {@link computeIncludeWarningPutsAccessAtRisk}).
 */
export function computeOverageUsageWarningRows(
	overage: AccountUsageComputeOverage,
): Array<ComputeOverageUsageRow> {
	if (!computeIncludeWarningPutsAccessAtRisk(overage.creditWallet)) return []
	return toComputeOverageUsageRows(overage).filter(
		(row) => row.overEightyPercent,
	)
}

function toComputeMeter(input: {
	resource: ComputeOverageWarningResource
	current: number
	include: number
	plan: PlanName
	creditWallet: CreditWalletState
}) {
	const visibility = computeOverageResourceVisibility[input.resource]
	const percentOfLimit =
		computeOverageIncludePercent(input.current, input.include) ?? 0
	return {
		resource: input.resource,
		label: computeOverageWarningResourceLabels[input.resource],
		whatCounts: visibility.whatCounts,
		howToReduce: buildComputeOverageHowToReduce(
			input.resource,
			input.plan,
			input.creditWallet,
		),
		current: input.current,
		include: input.include,
		percentOfLimit,
		overEightyPercent: percentOfLimit >= 0.8,
		creditsStatus: resolveComputeIncludeCreditsStatus({
			plan: input.plan,
			creditWallet: input.creditWallet,
			pastInclude: percentOfLimit > 1,
		}),
	}
}
