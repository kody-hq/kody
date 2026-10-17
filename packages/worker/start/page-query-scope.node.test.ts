import { expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { scopedPageResource } from './page-query-scope.ts'

it('updates typed collection inputs without crossing org or actor boundaries', () => {
	const client = new QueryClient()
	const key = (orgSlug: string, actor = 'one', jobId?: string) => [
		'page',
		actor,
		'loadJobsPage',
		{ orgSlug, jobId },
	]
	for (const queryKey of [
		key('alpha'),
		key('alpha', 'one', 'job'),
		key('beta'),
		key('alpha', 'two'),
	])
		client.setQueryData(queryKey, 'before')
	client.setQueriesData(
		scopedPageResource('one', 'loadJobsPage', { orgSlug: 'alpha' }),
		'after',
	)
	expect(client.getQueryData(key('alpha'))).toBe('after')
	expect(client.getQueryData(key('alpha', 'one', 'job'))).toBe('after')
	expect(client.getQueryData(key('beta'))).toBe('before')
	expect(client.getQueryData(key('alpha', 'two'))).toBe('before')
	client.clear()
})
