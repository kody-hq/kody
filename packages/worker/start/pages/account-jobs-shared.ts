import { createListDetailLinks } from '#client/list-detail-route.ts'
import { type AccountJobsViewFilter } from '#client/routes/account-jobs-filter.ts'
import { type AccountJobListItem } from '#universal/loader-data.ts'
import { colors } from '#universal/styles/tokens.ts'

export const jobsRoute = createListDetailLinks('/account/jobs')

export const viewFilterOptions: Array<{
	value: AccountJobsViewFilter
	label: string
}> = [
	{ value: 'active', label: 'Active' },
	{ value: 'history', label: 'History' },
	{ value: 'all', label: 'All' },
]

export type AccountJobsActionPayload = {
	ok: true
	jobId: string
	runNow?: { ok: boolean; error: string | null; deletedAfterRun: boolean }
}

export type PostAccountJobsAction<TInput> = (
	input: TInput & {
		successMessage: (payload: AccountJobsActionPayload) => string | null
		failureMessage: string
		afterSuccess?: (payload: AccountJobsActionPayload) => void
	},
) => Promise<void>

export function emptyJobsMessage(input: {
	totalCount: number
	filteredCount: number
	view: AccountJobsViewFilter
	search: string
}) {
	if (input.totalCount === 0) {
		return 'No scheduled jobs yet. Ask Kody to add one on a saved package.'
	}
	if (input.filteredCount > 0) return null
	if (input.search || input.view === 'all') {
		return 'No jobs match the current filters.'
	}
	if (input.view === 'history') {
		return 'No inactive or past jobs.'
	}
	return 'No active or upcoming jobs. Switch to History or All to see other jobs.'
}

export function packageLabel(job: Pick<AccountJobListItem, 'packageName'>) {
	return job.packageName ?? 'Package'
}

export function statusLabel(
	job: Pick<
		AccountJobListItem,
		'enabled' | 'killSwitchEnabled' | 'dueNow' | 'lastRunStatus' | 'expired'
	>,
) {
	if (job.killSwitchEnabled) return 'Kill switch on'
	if (job.expired) return 'Expired'
	if (!job.enabled) return 'Disabled'
	if (job.dueNow) return 'Due now'
	if (job.lastRunStatus === 'error') return 'Last run failed'
	if (job.lastRunStatus === 'success') return 'Last run ok'
	return 'Scheduled'
}

export function statusColor(
	job: Pick<
		AccountJobListItem,
		'enabled' | 'killSwitchEnabled' | 'dueNow' | 'lastRunStatus' | 'expired'
	>,
) {
	if (job.killSwitchEnabled) return colors.error
	if (job.expired) return colors.textMuted
	if (!job.enabled) return colors.textMuted
	if (job.dueNow) return colors.primary
	if (job.lastRunStatus === 'error') return colors.error
	if (job.lastRunStatus === 'success') return colors.primary
	return colors.textMuted
}

export function formatDurationMs(durationMs: number | null) {
	if (durationMs == null) return '—'
	if (durationMs < 1000) return `${durationMs} ms`
	return `${(durationMs / 1000).toFixed(1)} s`
}
