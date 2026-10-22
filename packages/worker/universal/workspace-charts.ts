import {
	type AccountActivityRunListItem,
	type AccountUsageLoaderData,
} from './loader-data.ts'

type RunSurface = AccountActivityRunListItem['surface']
type RunStatus = AccountActivityRunListItem['status']

export type WorkspaceRunBucket = {
	day: string
	surface: RunSurface
	status: RunStatus
	count: number
}
export type WorkspaceRunCharts = {
	since: string
	until: string
	/**
	 * Earliest UTC day present in the durable run-day counts table, or null
	 * when no counted runs exist yet. Used to disclose partial history after
	 * deploy (pre-deploy history cannot be recovered).
	 */
	countsSince: string | null
	days: Array<{ day: string; success: number; error: number; running: number }>
	sources: Array<{ surface: RunSurface; count: number }>
}
export type WorkspaceBilling = Pick<
	AccountUsageLoaderData,
	'whereItWent' | 'includedCompute' | 'creditsAlarm'
>

export function workspaceChartWindow(now = new Date()) {
	const until = now.toISOString()
	const start = new Date(until.slice(0, 10) + 'T00:00:00.000Z')
	start.setUTCDate(start.getUTCDate() - 6)
	return { since: start.toISOString(), until }
}

export function buildWorkspaceRunCharts(
	window: { since: string; until: string },
	buckets: Array<WorkspaceRunBucket>,
	countsSince: string | null = null,
): WorkspaceRunCharts {
	const days: WorkspaceRunCharts['days'] = []
	const date = new Date(window.since)
	while (date.toISOString().slice(0, 10) <= window.until.slice(0, 10)) {
		days.push({
			day: date.toISOString().slice(0, 10),
			success: 0,
			error: 0,
			running: 0,
		})
		date.setUTCDate(date.getUTCDate() + 1)
	}
	const sources = new Map<RunSurface, number>()
	for (const bucket of buckets) {
		const day = days.find((entry) => entry.day === bucket.day)
		if (!day) continue
		day[bucket.status] += bucket.count
		sources.set(
			bucket.surface,
			(sources.get(bucket.surface) ?? 0) + bucket.count,
		)
	}
	return {
		...window,
		countsSince,
		days,
		sources: [...sources]
			.map(([surface, count]) => ({ surface, count }))
			.sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface)),
	}
}

/**
 * When durable counting started after the chart window, return that UTC day so
 * the UI can say "Showing runs since …". Otherwise null (full window covered).
 */
export function workspaceChartsPartialSince(
	charts: Pick<WorkspaceRunCharts, 'since' | 'countsSince'>,
): string | null {
	if (!charts.countsSince) return null
	if (charts.countsSince <= charts.since.slice(0, 10)) return null
	return charts.countsSince
}

export function formatWorkspaceChartUtcDay(day: string) {
	return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

/** Totals for Overview tiles that must match the chart bars. */
export function overviewExecutionTotals(charts: WorkspaceRunCharts) {
	let total = 0
	let running = 0
	for (const day of charts.days) {
		total += day.success + day.error + day.running
		running += day.running
	}
	return { total, running }
}
