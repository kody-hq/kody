/** Same-page Credits section anchor on `/@:orgSlug/-/usage`. */
const usageCreditsSectionHref = '#credits'

/**
 * Customer framing shared by `/@:orgSlug/-/usage` (including its Credits
 * section) and the entitlement-warning emails so they tell one story:
 *
 * 1. Activity (code executions and runs) is the "how busy am I" signal.
 * 2. Worker compute and Rows read are a calm include: bars stop at 100% and
 *    past-include usage reads as dollars on credits, never a percentage.
 * 3. Alarms only fire when the wallet or access is actually at risk.
 *
 * Free never sees Worker compute as pressure: execute caps are its limit,
 * and past-include usage never charges or stops a Free account.
 */
import {
	computeOverageUnitLabels,
	computeOverageWarningResourceLabels,
	type ComputeOverageWarningResource,
} from './compute-overage.ts'
import {
	creditDebitCostMicroUsd,
	creditLowBalanceCents,
	formatEstimatedCreditMicroUsd,
	formatMicroUsd,
	microUsdPerCent,
} from './credits.ts'
import { type CreditWalletState, type PlanName } from './plans.ts'

/** Usage rollup metrics that count as customer activity, in display order. */
export const accountActivityMetrics = [
	'execute',
	'job_run',
	'workflow_run',
	'package_export',
] as const

export type AccountActivityMetric = (typeof accountActivityMetrics)[number]

const accountActivityLabels = {
	execute: 'Code executions',
	job_run: 'Job runs',
	workflow_run: 'Workflow runs',
	package_export: 'Package calls',
} as const satisfies Record<AccountActivityMetric, string>

export type AccountActivity = {
	/** UTC month the counts cover (`YYYY-MM`). */
	month: string
	metrics: Array<{
		metric: AccountActivityMetric
		label: string
		count: number
	}>
}

/** Packages and triggers nudge shown next to activity and included compute. */
export const warmWorkNudge =
	'Packages and triggers keep work warm and reuse the same worker, so the same useful work uses fewer Worker compute days than one-off runs.'

export function toAccountActivity(input: {
	month: string
	counts: Partial<Record<AccountActivityMetric, number>>
}): AccountActivity {
	return {
		month: input.month,
		metrics: accountActivityMetrics.map((metric) => ({
			metric,
			label: accountActivityLabels[metric],
			count: nonNegativeInteger(input.counts[metric]),
		})),
	}
}

/**
 * Width of an include progress bar. Always 0–100: once the include is used
 * up the bar is full, no matter how far past it usage went.
 */
export function includeBarPercent(ratio: number): number {
	if (!Number.isFinite(ratio) || ratio <= 0) return 0
	return Math.min(100, Math.round(ratio * 100))
}

/** Share of a limit or include as a label that never reads above 100%. */
export function formatCappedPercent(ratio: number | null): string {
	if (ratio === null) return '—'
	return `${includeBarPercent(ratio)}%`
}

/**
 * Dollars on credits: whole cents from $1 up, sub-cent precision below so a
 * real charge never reads as $0.00.
 */
export function formatOnCreditsMicroUsd(microUsd: number): string {
	if (!Number.isFinite(microUsd) || Math.abs(microUsd) < 1_000_000) {
		return formatEstimatedCreditMicroUsd(microUsd)
	}
	const dollars = (microUsd / 1_000_000).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})
	return `$${dollars}`
}

type IncludedComputeTone = 'calm' | 'attention'

/**
 * One monthly include meter ready to render. `informational` meters (Free)
 * show a count only: no include, no bar, no status that implies owing.
 */
export type IncludedComputeMeter = {
	resource: ComputeOverageWarningResource
	label: string
	unitLabel: string
	current: number
	include: number
	informational: boolean
	barPercent: number
	pastInclude: boolean
	tone: IncludedComputeTone
	status: string
	/** Credits drawn this month for usage past the include (funded wallets). */
	onCreditsMicroUsd: number
}

const attentionShare = 0.8

export function presentIncludedComputeMeter(input: {
	resource: ComputeOverageWarningResource
	current: number
	include: number
	plan: PlanName
	creditWallet: CreditWalletState
}): IncludedComputeMeter {
	const current = nonNegativeInteger(input.current)
	const include = nonNegativeInteger(input.include)
	const ratio = include > 0 ? current / include : current > 0 ? 1 : 0
	const pastInclude = current > include
	const informational = input.plan === 'free' && input.creditWallet === 'none'
	const onCreditsMicroUsd =
		input.creditWallet === 'funded' && pastInclude
			? creditDebitCostMicroUsd(input.resource, current - include)
			: 0
	const base = {
		resource: input.resource,
		label: computeOverageWarningResourceLabels[input.resource],
		unitLabel: computeOverageUnitLabels[input.resource],
		current,
		include,
		informational,
		barPercent: informational ? 0 : includeBarPercent(ratio),
		pastInclude,
		onCreditsMicroUsd,
	}
	if (informational) {
		return {
			...base,
			tone: 'calm',
			status: 'Informational · never charged on Free',
		}
	}
	if (!pastInclude) {
		return {
			...base,
			tone:
				input.creditWallet === 'empty' && ratio >= attentionShare
					? 'attention'
					: 'calm',
			status: `${formatCappedPercent(ratio)} of include`,
		}
	}
	switch (input.creditWallet) {
		case 'funded':
			return {
				...base,
				tone: 'calm',
				status: `Include used · ${formatOnCreditsMicroUsd(onCreditsMicroUsd)} on credits`,
			}
		case 'empty':
			return {
				...base,
				tone: 'attention',
				status: 'Include used · add credits to keep going',
			}
		case 'none':
			return { ...base, tone: 'calm', status: 'Include used · not charged' }
		default: {
			const exhaustive: never = input.creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}

export function presentIncludedCompute(input: {
	meters: ReadonlyArray<{
		resource: ComputeOverageWarningResource
		current: number
		include: number
	}>
	plan: PlanName
	creditWallet: CreditWalletState
}): Array<IncludedComputeMeter> {
	return input.meters.map((meter) =>
		presentIncludedComputeMeter({
			resource: meter.resource,
			current: meter.current,
			include: meter.include,
			plan: input.plan,
			creditWallet: input.creditWallet,
		}),
	)
}

/** Calm one-liner under the included compute meters. */
export function includedComputeSummary(input: {
	plan: PlanName
	creditWallet: CreditWalletState
	meters: ReadonlyArray<IncludedComputeMeter>
}): string {
	if (input.meters.some((meter) => meter.informational)) {
		return 'How Kody measures the infrastructure behind your runs. On Free it never charges you or stops runs; execute caps are your limit.'
	}
	const onCredits = input.meters.reduce(
		(total, meter) => total + meter.onCreditsMicroUsd,
		0,
	)
	switch (input.creditWallet) {
		case 'funded':
			return onCredits > 0
				? `Past this month's include, usage runs on credits: ${formatOnCreditsMicroUsd(onCredits)} so far.`
				: 'Included with Pro each month. Past the include, usage runs on credits.'
		case 'empty':
			return 'Included with Pro each month. With no credits, usage past the include stops.'
		case 'none':
			return input.plan === 'max'
				? 'Included each month.'
				: 'Included each month. Usage past the include is not charged on your plan.'
		default: {
			const exhaustive: never = input.creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}

type CreditsAlarmKind =
	| 'include_used_no_credits'
	| 'include_nearly_used_no_credits'
	| 'credits_low'
	| 'auto_refill_capped'

export type CreditsAlarm = {
	kind: CreditsAlarmKind
	tone: 'info' | 'warn'
	title: string
	body: string
	action: {
		/**
		 * Buy when the account can top up; otherwise open the Credits section
		 * (self-serve purchases still need a paid Pro subscription).
		 */
		label: 'Add credits' | 'Manage credits'
		href: typeof usageCreditsSectionHref
	}
}

export type CreditsAlarmAutoRefill = {
	enabled: boolean
	thresholdCents: number | null
	amountCents: number | null
	monthlyCapCents: number | null
	refilledThisMonthCents: number
}

/**
 * Whether auto-refill is enabled but another refill would pass the monthly
 * cap while the balance sits at or under the refill threshold.
 */
function isAutoRefillCapped(input: {
	autoRefill: CreditsAlarmAutoRefill
	balanceMicroUsd: number
}): boolean {
	const { autoRefill } = input
	if (!autoRefill.enabled) return false
	if (
		autoRefill.thresholdCents === null ||
		autoRefill.amountCents === null ||
		autoRefill.monthlyCapCents === null
	) {
		return false
	}
	if (input.balanceMicroUsd > autoRefill.thresholdCents * microUsdPerCent) {
		return false
	}
	return (
		autoRefill.refilledThisMonthCents + autoRefill.amountCents >
		autoRefill.monthlyCapCents
	)
}

/**
 * Why self-serve top-up is blocked when {@link canBuyCredits} is false.
 * Paid Pro without a Stripe customer is a different failure than a plan grant.
 */
export function buyCreditsUnavailableGuidance(
	hasPaidProSubscription: boolean,
): string {
	return hasPaidProSubscription
		? 'Buying credits is currently unavailable for this account.'
		: 'Buying credits requires a paid Pro subscription.'
}

/**
 * The one alarm the usage page may raise. `null` when nothing
 * is at risk, including a funded wallet past its include (that is just
 * credits doing their job) and every account without a wallet.
 */
export function resolveCreditsAlarm(input: {
	creditWallet: CreditWalletState
	meters: ReadonlyArray<Pick<IncludedComputeMeter, 'current' | 'include'>>
	balanceMicroUsd: number
	canBuyCredits: boolean
	/**
	 * Stripe purchasable Pro subscription (may still lack a customer id).
	 * Defaults false for callers that only know {@link canBuyCredits}.
	 */
	hasPaidProSubscription?: boolean
	autoRefill: CreditsAlarmAutoRefill | null
}): CreditsAlarm | null {
	const action = {
		label: input.canBuyCredits ? 'Add credits' : 'Manage credits',
		href: usageCreditsSectionHref,
	} as const
	const pastInclude = input.meters.some(
		(meter) => meter.current > meter.include,
	)
	const nearInclude = input.meters.some(
		(meter) =>
			meter.include > 0 && meter.current / meter.include >= attentionShare,
	)
	const balance = formatMicroUsd(input.balanceMicroUsd)
	const unavailable = buyCreditsUnavailableGuidance(
		input.hasPaidProSubscription === true,
	)
	switch (input.creditWallet) {
		case 'none':
			return null
		case 'empty':
			if (pastInclude) {
				return {
					kind: 'include_used_no_credits',
					tone: 'warn',
					title: 'Runs past the include are stopped',
					body: input.canBuyCredits
						? "This month's include is used up and there are no credits left. Add credits to keep going."
						: `This month's include is used up and there are no credits left. ${unavailable}`,
					action,
				}
			}
			if (nearInclude) {
				return {
					kind: 'include_nearly_used_no_credits',
					tone: 'info',
					title: "This month's include is nearly used",
					body: input.canBuyCredits
						? 'With no credits, usage past the include stops. Add credits to keep going past it.'
						: `With no credits, usage past the include stops. ${unavailable}`,
					action,
				}
			}
			return null
		case 'funded': {
			if (
				input.autoRefill &&
				isAutoRefillCapped({
					autoRefill: input.autoRefill,
					balanceMicroUsd: input.balanceMicroUsd,
				})
			) {
				return {
					kind: 'auto_refill_capped',
					tone: 'warn',
					title: 'Auto-refill hit its monthly cap',
					body: `Balance: ${balance}. Raise the cap or add credits. When credits run out, usage past the include stops.`,
					action,
				}
			}
			const autoRefillOn = input.autoRefill?.enabled ?? false
			const low =
				input.balanceMicroUsd <= creditLowBalanceCents * microUsdPerCent
			if (pastInclude && low && !autoRefillOn) {
				return {
					kind: 'credits_low',
					tone: 'warn',
					title: 'Credits running low',
					body: `Balance: ${balance}. This month's include is used up, so runs stop when credits run out.`,
					action,
				}
			}
			return null
		}
		default: {
			const exhaustive: never = input.creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}

/**
 * Monthly Worker compute / Rows read only warrants a customer warning (email
 * or usage-page warning row) when crossing the include would stop runs: an
 * empty purchasable-Pro wallet. Funded wallets keep running on credits (low
 * balance and auto-refill cap have their own emails); Free and other
 * wallet-less plans are never charged or stopped by these meters.
 */
export function computeIncludeWarningPutsAccessAtRisk(
	creditWallet: CreditWalletState,
): boolean {
	return creditWallet === 'empty'
}

function nonNegativeInteger(value: number | null | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return 0
	}
	return Math.trunc(value)
}
