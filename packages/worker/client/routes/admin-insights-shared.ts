import { chartColor } from '#client/charts/chart-theme.ts'
import { monthShortNames } from '#client/charts/usage-metric-series.ts'
import {
	adminCostRiskNoneStatus,
	fleetDynamicWorkerCostAlertUsd,
} from '#universal/dynamic-worker-cost.ts'
import {
	type AdminCostRiskKind,
	type AdminInsightsRunLogCompleteness,
	type AdminUsageMetric,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

export const planColors: Record<string, string> = {
	pro: chartColor.violet,
	free: chartColor.blue,
	standard: chartColor.emerald,
	max: chartColor.rose,
	none: chartColor.cyan,
}

export const workflowStatusColors: Record<string, string> = {
	complete: chartColor.emerald,
	completed: chartColor.emerald,
	running: chartColor.blue,
	queued: chartColor.cyan,
	waiting: chartColor.amber,
	paused: chartColor.amber,
	errored: chartColor.rose,
	failed: chartColor.rose,
	terminated: chartColor.fuchsia,
	unknown: chartColor.lime,
}

export const authCategoryColors: Record<string, string> = {
	auth: chartColor.blue,
	account: chartColor.emerald,
	admin: chartColor.amber,
	oauth: chartColor.violet,
}

/** `2026-06-29` -> `Jun 29` */
export function formatDayLabel(dayKey: string) {
	const monthIndex = Number(dayKey.slice(5, 7)) - 1
	const dayOfMonth = Number(dayKey.slice(8, 10))
	return `${monthShortNames[monthIndex] ?? '?'} ${dayOfMonth}`
}

export function formatPlanLabel(plan: string) {
	return plan === 'none' ? 'No plan' : plan
}

export function formatDurationHours(durationMs: number) {
	if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`
	const hours = durationMs / (60 * 60 * 1000)
	if (hours < 10) return `${hours.toFixed(1)}h`
	return `${Math.round(hours)}h`
}

export function formatPressurePercent(value: number) {
	return `${Math.round(value * 100)}%`
}

export function adminUserDetailHref(stableUserId: string) {
	return routes.adminUserDetail.href({ stableUserId })
}

export const runtimeDurationMetricLabels: Record<AdminUsageMetric, string> = {
	execute: 'Executes',
	package_export: 'Package runs',
	package_static_call: 'Static package calls',
	job_run: 'Job runs',
	workflow_run: 'Workflow runs',
	outbound_fetch: 'Fetches',
	email_send: 'Email sends',
	email_received: 'Email receives',
	dynamic_worker_day: 'Unique worker-days',
	dynamic_worker_cpu: 'Dynamic Worker CPU (Cloudflare-measured)',
	durable_object_gb_seconds: 'Durable Object duration (GB-s)',
	durable_object_rows_read: 'Durable Object rows read',
	durable_object_platform_rows_read: 'Platform DO rows read (RunLog)',
}

export function formatUsdFromCents(cents: number) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
	}).format(cents / 100)
}

export function formatAdminCostRiskLabel(
	risk: AdminCostRiskKind,
	estimatedGrossUsd = 0,
): string | null {
	switch (risk) {
		case 'none':
			return null
		case 'paid_underwater':
			return 'paid underwater'
		case 'free_near_allotment': {
			const freeAlertUsd = fleetDynamicWorkerCostAlertUsd('free') ?? 2
			return estimatedGrossUsd >= freeAlertUsd
				? 'past included allotment'
				: 'near included allotment'
		}
		case 'missing_price_id':
			return 'paid unknown'
		default: {
			const exhaustive: never = risk
			throw new Error(`Unknown cost risk: ${String(exhaustive)}`)
		}
	}
}

export function formatAdminCostRiskStatus(input: {
	risk: AdminCostRiskKind
	estimatedGrossUsd: number
	estimatedPaidUsdCents: number
}) {
	return (
		formatAdminCostRiskLabel(input.risk, input.estimatedGrossUsd) ??
		adminCostRiskNoneStatus(input)
	)
}

/** Null when run-derived totals are complete; otherwise a user-facing warning. */
export function formatRunLogCompletenessWarning(
	completeness: AdminInsightsRunLogCompleteness,
): string | null {
	if (completeness.complete) return null
	if (completeness.snapshotUpdatedAt == null) {
		return 'Workflow and package-activation totals refresh hourly off this page. No snapshot yet.'
	}
	return `Workflow and activation totals are partial — loaded RunLog snapshots for ${completeness.usersLoaded} of ${completeness.usersAttempted} users.`
}
