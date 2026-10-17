import { matchesSearchQuery } from '#client/search-filter.ts'

export type AccountJobsViewFilter = 'active' | 'history' | 'all'

export type FilterableAccountJob = {
	id: string
	name: string
	packageName?: string | null
	scheduleSummary: string
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	dueNow: boolean
	lastRunStatus: string | null
	nextRunAt: string
	scheduleType: 'once' | 'interval' | 'cron'
}

/**
 * Ops-surface rule: live work plus upcoming one-offs.
 * enabled OR (once schedule with a future run_at / nextRunAt).
 */
export function isActiveAccountJob(
	job: Pick<FilterableAccountJob, 'enabled' | 'scheduleType' | 'nextRunAt'>,
	nowMs: number = Date.now(),
) {
	if (job.enabled) return true
	if (job.scheduleType !== 'once') return false
	const runAtMs = Date.parse(job.nextRunAt)
	return Number.isFinite(runAtMs) && runAtMs > nowMs
}

export function filterAccountJobs<Job extends FilterableAccountJob>(
	jobs: ReadonlyArray<Job>,
	input: {
		view: AccountJobsViewFilter
		search: string
		nowMs?: number
	},
): Array<Job> {
	const nowMs = input.nowMs ?? Date.now()
	return jobs.filter((job) => {
		if (input.view !== 'all') {
			const active = isActiveAccountJob(job, nowMs)
			if (input.view === 'active' ? !active : active) return false
		}
		return matchesSearchQuery(input.search, [
			job.name,
			job.id,
			job.packageName ?? '',
			job.scheduleSummary,
			job.timezone,
			job.lastRunStatus,
			job.enabled ? 'enabled' : 'disabled',
			job.killSwitchEnabled ? 'kill switch' : '',
			job.dueNow ? 'due' : '',
			job.scheduleType,
		])
	})
}
