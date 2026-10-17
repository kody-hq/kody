import { defaultParseSearch } from '@tanstack/react-router'
import { collectionSearch } from '../../start/filter-search.ts'
import { expect, test } from 'vitest'
import {
	filterAccountJobs,
	isActiveAccountJob,
	type FilterableAccountJob,
} from './account-jobs-filter.ts'

const nowMs = Date.parse('2026-07-27T12:00:00.000Z')

function job(
	id: string,
	overrides: Partial<FilterableAccountJob> = {},
): FilterableAccountJob {
	return {
		id,
		name: id,
		scheduleSummary: 'summary',
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		dueNow: false,
		lastRunStatus: null,
		nextRunAt: '2026-07-28T12:00:00.000Z',
		scheduleType: 'cron',
		...overrides,
	}
}

const once = (nextRunAt: string) =>
	({ enabled: false, scheduleType: 'once', nextRunAt }) as const

test('account jobs filters cover active/history views and search', () => {
	const activeCases: Array<[FilterableAccountJob, boolean]> = [
		[job('enabled-cron'), true],
		[job('future-once', once('2026-07-28T00:00:00.000Z')), true],
		[job('past-once', once('2026-07-26T00:00:00.000Z')), false],
		[
			job('disabled-interval', {
				enabled: false,
				scheduleType: 'interval',
				nextRunAt: '2026-07-28T00:00:00.000Z',
			}),
			false,
		],
	]
	expect(
		activeCases
			.filter(([item, want]) => isActiveAccountJob(item, nowMs) !== want)
			.map(([item]) => item.id),
	).toEqual([])

	const views = [
		['/account/jobs', 'active'],
		['/account/jobs?view=history', 'history'],
		['/account/jobs?view=all', 'all'],
		['/account/jobs?view=nope', 'active'],
	] as const
	expect(
		views.map(([href]) => [
			href,
			collectionSearch(
				defaultParseSearch(new URL(href, 'https://kody.local').search),
			).view,
		]),
	).toEqual(views)

	const jobs = [
		job('live-cron', { name: 'Live digest' }),
		job('live-package', { name: 'Package digest' }),
		job('upcoming-once', {
			name: 'Tomorrow ping',
			...once('2026-07-28T09:00:00.000Z'),
		}),
		job('failed-once', {
			name: 'Failed ping',
			...once('2026-07-20T09:00:00.000Z'),
		}),
		job('disabled-package', { name: 'Old package digest', enabled: false }),
	]
	const ids = (view: 'active' | 'history' | 'all', search = '', list = jobs) =>
		filterAccountJobs(list, { view, search, nowMs }).map((item) => item.id)

	expect(ids('active')).toEqual(['live-cron', 'live-package', 'upcoming-once'])
	expect(ids('history')).toEqual(['failed-once', 'disabled-package'])
	expect(ids('all')).toEqual([
		'live-cron',
		'live-package',
		'upcoming-once',
		'failed-once',
		'disabled-package',
	])
	expect(ids('history', 'failed')).toEqual(['failed-once'])
	expect(
		ids('all', 'state store', [
			job('named-package', {
				name: 'Nightly sync',
				packageName: 'State Store',
			}),
		]),
	).toEqual(['named-package'])
})
