import { defaultParseSearch } from '@tanstack/react-router'
import { collectionSearch } from '../../start/filter-search.ts'
import { expect, test } from 'vitest'
import {
	filterAccountWorkflows,
	isActiveAccountWorkflow,
	type FilterableAccountWorkflow,
} from './account-workflows-filter.ts'

function workflow(
	id: string,
	workflowName: string,
	status: FilterableAccountWorkflow['status'],
	overrides: Partial<FilterableAccountWorkflow> = {},
): FilterableAccountWorkflow {
	return {
		id,
		sourceType: 'inline',
		workflowName,
		status,
		runAt: '2026-07-28T12:00:00.000Z',
		...overrides,
	}
}

test('account workflows filters cover active/history views and search', () => {
	const views = [
		['/account/workflows', 'active'],
		['/account/workflows?view=history', 'history'],
		['/account/workflows?view=all', 'all'],
		['/account/workflows?view=nope', 'active'],
	] as const
	expect(
		views.map(([href]) => [
			href,
			collectionSearch(
				defaultParseSearch(new URL(href, 'https://kody.local').search),
			).view,
		]),
	).toEqual(views)

	const workflows = [
		workflow('live-queued', 'Send digest', 'queued'),
		workflow('live-running', 'Package sync', 'running', {
			sourceType: 'package',
			packageId: 'pkg-1',
		}),
		workflow('done-complete', 'Finished digest', 'complete'),
		workflow('done-errored', 'Failed ping', 'errored', { lastError: 'boom' }),
	]
	expect(isActiveAccountWorkflow(workflows[0]!)).toBe(true)
	expect(isActiveAccountWorkflow(workflows[2]!)).toBe(false)

	const ids = (view: 'active' | 'history' | 'all', search = '') =>
		filterAccountWorkflows(workflows, { view, search }).map((item) => item.id)
	expect(ids('active')).toEqual(['live-queued', 'live-running'])
	expect(ids('history')).toEqual(['done-complete', 'done-errored'])
	expect(ids('all')).toEqual([
		'live-queued',
		'live-running',
		'done-complete',
		'done-errored',
	])
	expect(ids('history', 'failed')).toEqual(['done-errored'])
	expect(ids('all', 'pkg-1')).toEqual(['live-running'])
})
