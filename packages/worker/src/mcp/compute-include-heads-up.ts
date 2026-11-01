import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { computeOverageIncludePercent } from '#universal/compute-overage.ts'
import { type CreditWalletState } from '#universal/plans.ts'
import { userEntitlementApproachingThreshold } from '#worker/entitlements/user-entitlement-warning-emails.ts'

/**
 * One-time-per-month heads-up on a hosted execute response when the org
 * crosses 80% of its included monthly Worker compute. Complements the
 * hourly 80% / 100% warning emails: agents see it where they spend units.
 */
export const computeIncludeHeadsUpKvKeyPrefix =
	'execute-compute-include-heads-up:v1'

/** Outlives the month so a late claim cannot repeat inside it. */
export const computeIncludeHeadsUpClaimTtlSeconds = 40 * 24 * 60 * 60

export function computeIncludeHeadsUpKvKey(ownerId: string, now: Date) {
	return `${computeIncludeHeadsUpKvKeyPrefix}:${ownerId}:${utcMonthKey(now)}`
}

/**
 * Heads-up text, or null when nothing should show: wallet-less plans are
 * never charged or stopped by the include, and below 80% there is nothing
 * to say.
 */
export function formatComputeIncludeHeadsUp(input: {
	used: number
	include: number
	creditWallet: CreditWalletState
	usageUrl: string
}): string | null {
	if (input.creditWallet === 'none') return null
	if (!Number.isFinite(input.include) || input.include <= 0) return null
	const percent = computeOverageIncludePercent(input.used, input.include)
	if (percent === null || percent < userEntitlementApproachingThreshold) {
		return null
	}
	const past =
		input.creditWallet === 'funded'
			? 'Units past the include spend credits.'
			: 'Past the include, new hosted workers stop until credits are added.'
	return [
		`Usage heads-up: this org has used ${formatCount(input.used)} of ${formatCount(input.include)} included Worker compute units this month (${Math.floor(percent * 100)}%).`,
		past,
		'Runs on an execution context (your machine) use none; reusing the same code and passing params reuses its worker for the day.',
		`See which packages and connections start the most workers: ${input.usageUrl}#where-it-went (or call usageByPackageGet).`,
		'Shown once a month; an Owner can turn usage warnings off with orgUpdate usage_warnings: false.',
	].join(' ')
}

function formatCount(value: number) {
	return Math.round(value).toLocaleString('en-US')
}
