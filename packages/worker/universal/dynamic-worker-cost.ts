import type { PlanName } from './plans.ts'

/**
 * Cloudflare Dynamic Worker list price used for operator cost estimates.
 *
 * Cloudflare bills $0.002 per unique worker id per UTC day. Fleet-level
 * estimates still cite Cloudflare's account-wide 1,000 unique worker-day
 * include. Per-user admin usage passes the account's plan include from
 * `resolvePlanLimits(...).maxUniqueWorkerDaysPerMonth` instead — the CF
 * bucket is not a per-user allotment.
 */

const dynamicWorkerUsdPerUniqueDay = 0.002
/** Cloudflare's account-wide unique-worker-day include (fleet estimates). */
const dynamicWorkersIncludedPerAccountMonth = 1000

/**
 * Gross unique-worker-day cost at which a non-admin account pages operators.
 * Paid thresholds match monthly list price (the unique-execute break-even).
 * Free uses the account-wide included allotment ($2 = 1,000 unique days) so
 * one Free account eating that bucket is enough to look.
 */
const fleetDynamicWorkerCostAlertUsdByPlan = {
	free: 2,
	standard: 12,
	pro: 49,
} as const

/**
 * Unpaid accounts enter the insights warn bucket at this fraction of the
 * Free fleet alert ($2 / 1,000 unique days). Half is $1 / 500 days.
 */
export const fleetFreeDynamicWorkerNearAllotmentFraction = 0.5

export function fleetFreeDynamicWorkerNearAllotmentUsd(): number {
	return (
		fleetDynamicWorkerCostAlertUsdByPlan.free *
		fleetFreeDynamicWorkerNearAllotmentFraction
	)
}

export function adminCostRiskNoneStatus(input: {
	estimatedGrossUsd: number
	estimatedPaidUsdCents: number
}): 'above cost' | 'within included allotment' | 'not flagged' {
	if (input.estimatedPaidUsdCents > 0) {
		return input.estimatedGrossUsd > input.estimatedPaidUsdCents / 100
			? 'not flagged'
			: 'above cost'
	}
	return input.estimatedGrossUsd >= fleetFreeDynamicWorkerNearAllotmentUsd()
		? 'not flagged'
		: 'within included allotment'
}

export function fleetDynamicWorkerCostAlertUsd(plan: PlanName): number | null {
	switch (plan) {
		case 'free':
			return fleetDynamicWorkerCostAlertUsdByPlan.free
		case 'standard':
			return fleetDynamicWorkerCostAlertUsdByPlan.standard
		case 'pro':
			return fleetDynamicWorkerCostAlertUsdByPlan.pro
		case 'max':
			return null
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}

export function estimateDynamicWorkerUsd(uniqueWorkerDays: number): number {
	const safeDays = Number.isFinite(uniqueWorkerDays)
		? Math.max(0, uniqueWorkerDays)
		: 0
	return safeDays * dynamicWorkerUsdPerUniqueDay
}

/**
 * Per-user Dynamic Worker cost block for admin usage. Pass
 * `includedPerAccountMonth` from
 * `resolvePlanLimits(...).maxUniqueWorkerDaysPerMonth` so the include
 * matches the user's entitlement. Fleet callers omit it and keep
 * Cloudflare's account-wide 1,000-day bucket.
 */
export function toAdminDynamicWorkerCost(
	uniqueWorkerDays: number,
	includedPerAccountMonth: number = dynamicWorkersIncludedPerAccountMonth,
) {
	const safeDays = Number.isFinite(uniqueWorkerDays)
		? Math.max(0, Math.trunc(uniqueWorkerDays))
		: 0
	const safeInclude = Number.isFinite(includedPerAccountMonth)
		? Math.max(0, Math.trunc(includedPerAccountMonth))
		: dynamicWorkersIncludedPerAccountMonth
	return {
		uniqueWorkerDays: safeDays,
		estimatedGrossUsd: estimateDynamicWorkerUsd(safeDays),
		usdPerUniqueDay: dynamicWorkerUsdPerUniqueDay,
		includedPerAccountMonth: safeInclude,
	}
}

let usdFormatter: Intl.NumberFormat | null = null

/**
 * Format a Dynamic Worker cost so $0.002 stays visible. The formatter is built
 * on first use: constructing `Intl.NumberFormat` loads ICU data, which is
 * measurable Worker startup CPU when it runs at module scope.
 */
export function formatDynamicWorkerUsd(amount: number): string {
	usdFormatter ??= new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 3,
	})
	return usdFormatter.format(amount)
}

export const dynamicWorkerCostFootnote =
	'Gross estimate: unique Dynamic Worker ids × $0.002 per UTC day. Cloudflare includes 1,000 unique worker-days per account per month, so this is not a net bill share.'

export const costVsPayFootnote =
	'Cost is a Cloudflare list-rate estimate on unique Dynamic Worker days only (gross, not a net bill share). The account-wide 1,000 unique days (~$2) included bucket is not subtracted per user. Paid is catalog list MRR from stored stripe_price_id. Gift, referral, max, and manual-only access count as $0. Risk is paid accounts over that list pay, unpaid accounts at ≥$1 / 500 unique days (50% of the $2 included-bucket alert), and Standard/Pro stripe_plan rows whose stripe_price_id is missing or not in the catalog — not every free user with pennies of usage. Not invoice-perfect: no tax, coupons, overage invoices, email, or storage.'
