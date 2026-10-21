import { expect, test } from 'vitest'
import {
	activityEmptyLabel,
	buildActivitySearch,
	readAccountActivityFilters,
	statusFilterToRunStatus,
	surfaceFilterToRunSurface,
} from './account-activity-filters.ts'

type Search = Parameters<typeof buildActivitySearch>[0]

const errorsDefault: Search = {
	view: 'errors',
	status: 'error',
	surface: 'all',
	triage: 'open',
}
const recentDefault: Search = {
	view: 'recent',
	status: 'all',
	surface: 'all',
	triage: 'all',
}

test('activity URL defaults stay on open errors and recent runs flip to all history', () => {
	const filters = (
		viewFilter: string,
		statusFilter: string,
		surfaceFilter: string,
		triageFilter: string,
		cursor: string | null = null,
	) => ({ viewFilter, statusFilter, surfaceFilter, triageFilter, cursor })
	const reads: Array<[search: string, ReturnType<typeof filters>]> = [
		['', filters('errors', 'error', 'all', 'open')],
		[
			'?status=all&surface=job&cursor=abc&error_triage=ignored',
			filters('errors', 'all', 'job', 'ignored', 'abc'),
		],
		['?view=recent', filters('recent', 'all', 'all', 'all')],
		[
			'?view=recent&status=success&surface=webhook',
			filters('recent', 'success', 'webhook', 'all'),
		],
		['?view=nope&status=success', filters('errors', 'success', 'all', 'open')],
	]
	expect(
		reads.map(([search]) => [
			search,
			readAccountActivityFilters(
				`https://example.com/account/activity${search}`,
			),
		]),
	).toEqual(reads)

	expect(
		(['error', 'success', 'running', 'all'] as const).map(
			statusFilterToRunStatus,
		),
	).toEqual(['error', 'success', 'running', null])
	expect((['all', 'webhook'] as const).map(surfaceFilterToRunSurface)).toEqual([
		null,
		'webhook',
	])

	const searches: Array<Search> = [
		errorsDefault,
		recentDefault,
		{ view: 'recent', status: 'success', surface: 'job', triage: 'open' },
	]
	expect(searches.map(buildActivitySearch)).toEqual([
		'',
		'?view=recent',
		'?view=recent&status=success&surface=job&error_triage=open',
	])

	expect(activityEmptyLabel({ ...errorsDefault, summaryTotal: 0 })).toMatch(
		/No failures in the last 7 days/,
	)
	expect(activityEmptyLabel({ ...errorsDefault, summaryTotal: 4 })).toMatch(
		/Switch to Recent runs/,
	)
	expect(activityEmptyLabel({ ...recentDefault, summaryTotal: 0 })).toBe(
		'Nothing ran in the last 7 days.',
	)
	expect(
		activityEmptyLabel({
			...recentDefault,
			status: 'success',
			summaryTotal: 3,
		}),
	).toBe('No runs match the current filters.')
})
