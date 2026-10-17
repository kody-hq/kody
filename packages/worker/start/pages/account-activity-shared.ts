import { createListDetailLinks } from '#client/list-detail-route.ts'
import {
	type AccountActivityStatusFilter,
	type AccountActivitySurfaceFilter,
	type AccountActivityTriageFilter,
	type AccountActivityViewFilter,
} from '#universal/account-activity-filters.ts'
import {
	type AccountActivityRunDetail,
	type AccountActivityRunListItem,
} from '#universal/loader-data.ts'
import { colors } from '#universal/styles/tokens.ts'

export {
	activityEmptyLabel,
	buildActivitySearch,
	readAccountActivityStatusFilter as readStatusFilter,
	readAccountActivitySurfaceFilter as readSurfaceFilter,
	readAccountActivityTriageFilter as readTriageFilter,
	readAccountActivityViewFilter as readViewFilter,
} from '#universal/account-activity-filters.ts'

export const activityErrorReviewPrompt = [
	'Look at my open Kody activity errors.',
	'Start with runSummary, then runList for open errors, and runGet on the ones that matter.',
	'Explain each failure and recommend whether to ignore it, mark it resolved, or fix something.',
].join(' ')

export const activityRoute = createListDetailLinks('/account/activity')

export const viewFilterOptions: Array<{
	value: AccountActivityViewFilter
	label: string
}> = [
	{ value: 'errors', label: 'Open errors' },
	{ value: 'recent', label: 'Recent runs' },
]

export const statusFilterOptions: Array<{
	value: AccountActivityStatusFilter
	label: string
}> = [
	{ value: 'error', label: 'Errors' },
	{ value: 'all', label: 'All' },
	{ value: 'success', label: 'Success' },
	{ value: 'running', label: 'Running' },
]

export const triageFilterOptions: Array<{
	value: AccountActivityTriageFilter
	label: string
}> = [
	{ value: 'open', label: 'Open' },
	{ value: 'ignored', label: 'Ignored' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'all', label: 'All triage' },
]

export const surfaceFilterOptions: Array<{
	value: AccountActivitySurfaceFilter
	label: string
}> = [
	{ value: 'all', label: 'All surfaces' },
	{ value: 'execute', label: 'Execute' },
	{ value: 'export', label: 'Export' },
	{ value: 'subscription', label: 'Subscription' },
	{ value: 'app_fetch', label: 'App fetch' },
	{ value: 'app_realtime', label: 'App realtime' },
	{ value: 'job', label: 'Job' },
	{ value: 'workflow', label: 'Workflow' },
	{ value: 'retriever', label: 'Retriever' },
	{ value: 'webhook', label: 'Webhook' },
]

export function surfaceLabel(surface: AccountActivityRunListItem['surface']) {
	const match = surfaceFilterOptions.find((option) => option.value === surface)
	return match?.label ?? surface
}

export function statusLabel(status: AccountActivityRunListItem['status']) {
	switch (status) {
		case 'error':
			return 'Error'
		case 'success':
			return 'Success'
		case 'running':
			return 'Running'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export function statusColor(status: AccountActivityRunListItem['status']) {
	switch (status) {
		case 'error':
			return colors.error
		case 'success':
			return colors.primary
		case 'running':
			return colors.textMuted
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export function logLevelColor(
	level: AccountActivityRunDetail['logs'][number]['level'],
) {
	switch (level) {
		case 'error':
			return colors.error
		case 'warn':
			return colors.dangerHover
		case 'debug':
			return colors.textMuted
		case 'info':
		case 'log':
			return colors.text
		default: {
			const exhaustive: never = level
			return exhaustive
		}
	}
}

export function formatDurationMs(durationMs: number | null) {
	if (durationMs == null) return '—'
	if (durationMs < 1000) return `${durationMs} ms`
	return `${(durationMs / 1000).toFixed(1)} s`
}

export function runDisplayName(run: AccountActivityRunListItem) {
	return run.name?.trim() || surfaceLabel(run.surface)
}

export function runAttributionSubtitle(
	run: Pick<AccountActivityRunListItem, 'entry' | 'workerId'>,
) {
	const parts: Array<string> = []
	if (run.entry === 'invoke') parts.push('invoke')
	else if (run.entry === 'code') parts.push('code')
	if (run.workerId) {
		const shortId =
			run.workerId.length > 16 ? `${run.workerId.slice(0, 12)}…` : run.workerId
		parts.push(shortId)
	}
	return parts.length > 0 ? parts.join(' · ') : null
}

export function triageLabel(
	run: Pick<AccountActivityRunListItem, 'status' | 'errorTriage'>,
) {
	if (run.status !== 'error') return '—'
	switch (run.errorTriage) {
		case 'ignored':
			return 'Ignored'
		case 'resolved':
			return 'Resolved'
		case null:
			return 'Open'
		default: {
			const exhaustive: never = run.errorTriage
			return exhaustive
		}
	}
}
