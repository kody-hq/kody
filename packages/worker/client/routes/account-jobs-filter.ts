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
	scheduleType: 'interval' | 'cron'
}

export function isActiveAccountJob(job: Pick<FilterableAccountJob, 'enabled'>) {
	return job.enabled
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
			const active = isActiveAccountJob(job)
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
