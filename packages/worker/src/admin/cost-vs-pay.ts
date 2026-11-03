/**
 * Operator cost vs list-pay estimates. Unique worker-days and stored Stripe
 * price ids only — no Stripe API and no per-user usage fan-out.
 *
 * Risk is not "any unpaid usage." Free/gift/max/referral/manual-only count as
 * $0 paid, so pennies of Dynamic Worker usage used to look underwater. The
 * risk buckets below match what operators should actually look at.
 */

import {
	fleetDynamicWorkerCostAlertUsd,
	fleetFreeDynamicWorkerNearAllotmentFraction,
	toAdminDynamicWorkerCost,
} from '#universal/dynamic-worker-cost.ts'
import type {
	AdminCostRiskKind,
	AdminCostVsPay,
	AdminInsightsDynamicWorkerCostConsumer,
	AdminPaidSource,
} from '#universal/loader-data.ts'
import { parsePlanName, parseStripePlanName } from '#universal/plans.ts'
import {
	monthlyRecurringRevenueUsdCents,
	type StripePriceCatalogEntry,
} from '#worker/billing/stripe-price-catalog.ts'

export const adminFleetCostVsPayScanLimit = 25
export const adminFleetCostVsPayDisplayLimit = 10

const operatorNoiseUsernames = new Set(['kentcdodds'])

const riskBucketPriority: Record<AdminCostRiskKind, number> = {
	paid_underwater: 0,
	free_near_allotment: 1,
	missing_price_id: 2,
	none: 3,
}

export function estimatePaidListMrrUsdCents(input: {
	stripePlan: string | null | undefined
	stripePriceId: string | null | undefined
	catalog: Map<string, StripePriceCatalogEntry>
	/**
	 * Live owner/member seat count. Applied only when the catalog entry has
	 * `seatQuantityTracksMembers` (purchasable Pro). Retired prices keep unit
	 * list MRR because seat sync does not update their Stripe quantity.
	 */
	quantity?: number
}): { cents: number; source: AdminPaidSource } {
	const plan = input.stripePlan?.trim() ?? ''
	if (plan !== 'standard' && plan !== 'pro') {
		return { cents: 0, source: 'none' }
	}
	const priceId = input.stripePriceId?.trim() ?? ''
	if (!priceId) return { cents: 0, source: 'none' }
	const entry = input.catalog.get(priceId)
	if (!entry) return { cents: 0, source: 'none' }
	const quantity =
		entry.seatQuantityTracksMembers &&
		typeof input.quantity === 'number' &&
		Number.isSafeInteger(input.quantity) &&
		input.quantity >= 1
			? input.quantity
			: 1
	return {
		cents: monthlyRecurringRevenueUsdCents(entry) * quantity,
		source: 'stripe_catalog',
	}
}

export function isOperatorCostNoise(input: {
	username?: string | null | undefined
	manualPlan?: string | null | undefined
}): boolean {
	const username = input.username?.trim().toLowerCase()
	if (username && operatorNoiseUsernames.has(username)) return true
	return parsePlanName(input.manualPlan) === 'max'
}

export function classifyAdminCostRisk(input: {
	estimatedGrossUsd: number
	estimatedPaidUsdCents: number
	paidSource: AdminPaidSource
	stripePlan: string | null | undefined
	manualPlan?: string | null | undefined
	username?: string | null | undefined
	isOperator?: boolean
}): AdminCostRiskKind {
	if (isOperatorCostNoise(input)) return 'none'

	if (input.paidSource === 'stripe_catalog') {
		return input.estimatedGrossUsd > input.estimatedPaidUsdCents / 100
			? 'paid_underwater'
			: 'none'
	}

	const stripePlan = parseStripePlanName(input.stripePlan)
	if (stripePlan === 'standard' || stripePlan === 'pro') {
		return 'missing_price_id'
	}

	// Admin-role dogfooding stays out of the unpaid warn bucket. Catalog-paid
	// admins over list MRR still count as paid_underwater above.
	if (input.isOperator) return 'none'

	const freeAlertUsd = fleetDynamicWorkerCostAlertUsd('free')
	if (
		freeAlertUsd != null &&
		input.estimatedGrossUsd >=
			freeAlertUsd * fleetFreeDynamicWorkerNearAllotmentFraction
	) {
		return 'free_near_allotment'
	}

	return 'none'
}

export function toAdminCostVsPay(input: {
	uniqueWorkerDays: number
	stripePlan: string | null | undefined
	stripePriceId: string | null | undefined
	catalog: Map<string, StripePriceCatalogEntry>
	manualPlan?: string | null | undefined
	username?: string | null | undefined
	isOperator?: boolean
	/** Plan include; omit for fleet estimates (Cloudflare account-wide 1,000). */
	includedPerAccountMonth?: number
	/**
	 * Live seats for purchasable-Pro list MRR. Ignored for retired prices.
	 */
	quantity?: number
}): AdminCostVsPay {
	const cost = toAdminDynamicWorkerCost(
		input.uniqueWorkerDays,
		input.includedPerAccountMonth,
	)
	const paid = estimatePaidListMrrUsdCents(input)
	const paidUsd = paid.cents / 100
	const risk = classifyAdminCostRisk({
		estimatedGrossUsd: cost.estimatedGrossUsd,
		estimatedPaidUsdCents: paid.cents,
		paidSource: paid.source,
		stripePlan: input.stripePlan,
		manualPlan: input.manualPlan,
		username: input.username,
		isOperator: input.isOperator,
	})
	return {
		...cost,
		estimatedPaidUsdCents: paid.cents,
		estimatedMarginUsd: paidUsd - cost.estimatedGrossUsd,
		underwater: risk === 'paid_underwater',
		paidSource: paid.source,
		risk,
	}
}

export function toAdminCostVsPayConsumer(input: {
	stableUserId: string
	username: string
	uniqueWorkerDays: number
	stripePlan: string | null | undefined
	stripePriceId: string | null | undefined
	catalog: Map<string, StripePriceCatalogEntry>
	manualPlan?: string | null | undefined
	isOperator?: boolean
}): AdminInsightsDynamicWorkerCostConsumer {
	const costVsPay = toAdminCostVsPay(input)
	return {
		stableUserId: input.stableUserId,
		username: input.username,
		uniqueWorkerDays: costVsPay.uniqueWorkerDays,
		estimatedGrossUsd: costVsPay.estimatedGrossUsd,
		estimatedPaidUsdCents: costVsPay.estimatedPaidUsdCents,
		estimatedMarginUsd: costVsPay.estimatedMarginUsd,
		underwater: costVsPay.underwater,
		paidSource: costVsPay.paidSource,
		risk: costVsPay.risk,
	}
}

function adminCostRiskScore(
	consumer: Pick<
		AdminInsightsDynamicWorkerCostConsumer,
		'risk' | 'estimatedGrossUsd' | 'estimatedPaidUsdCents'
	>,
): number {
	switch (consumer.risk) {
		case 'paid_underwater':
			return consumer.estimatedGrossUsd - consumer.estimatedPaidUsdCents / 100
		case 'free_near_allotment': {
			const freeAlertUsd = fleetDynamicWorkerCostAlertUsd('free') ?? 0
			return freeAlertUsd > 0 ? consumer.estimatedGrossUsd / freeAlertUsd : 0
		}
		case 'missing_price_id':
			return consumer.estimatedGrossUsd
		case 'none':
			return 0
		default: {
			const exhaustive: never = consumer.risk
			throw new Error(`Unknown cost risk: ${String(exhaustive)}`)
		}
	}
}

export function rankRiskCostConsumers(
	consumers: ReadonlyArray<AdminInsightsDynamicWorkerCostConsumer>,
	limit = adminFleetCostVsPayDisplayLimit,
) {
	return consumers
		.filter((consumer) => consumer.risk !== 'none')
		.toSorted((left, right) => {
			const bucket =
				riskBucketPriority[left.risk] - riskBucketPriority[right.risk]
			if (bucket !== 0) return bucket
			return adminCostRiskScore(right) - adminCostRiskScore(left)
		})
		.slice(0, limit)
}
