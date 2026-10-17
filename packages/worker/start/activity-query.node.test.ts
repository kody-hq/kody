import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import { expect, it, vi } from 'vitest'
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { activityQuery, loadActivityQuery } from './activity-query.ts'
import { activityInput } from './activity-input.ts'
import { loadActivityPage } from '#start/server/account-collections'

vi.mock('#start/server/account-collections', () => ({
	loadActivityPage: vi.fn(),
}))

function activityPage(
	id: string | null,
	nextCursor: string | null,
): Awaited<ReturnType<typeof loadActivityPage>> {
	return {
		payload: {
			ok: true,
			viewFilter: 'recent',
			statusFilter: 'all',
			surfaceFilter: 'all',
			triageFilter: 'all',
			summary: {
				since: '2026-01-01',
				total: 0,
				errors: 0,
				ignored: 0,
				resolved: 0,
				running: 0,
			},
			runs:
				id === null
					? []
					: [
							{
								id,
								surface: 'execute',
								status: 'success',
								name: null,
								startedAt: '2026-01-01',
								finishedAt: null,
								durationMs: null,
								errorName: null,
								errorMessage: null,
								errorTriage: null,
								packageId: null,
								jobId: null,
								logCount: 0,
								idempotencyKey: null,
								entry: null,
								workerId: null,
							},
						],
			nextCursor,
			selectedRun: null,
			selectedRunId: null,
			retentionDays: 30,
		},
		head: absolutizeDocumentHead(
			resolveDocumentHead('orgActivity', '/account/activity'),
			'https://example.com',
		),
	}
}
it('reuses loader data and preserves org and filters across cursor pages', async () => {
	const read = vi.mocked(loadActivityPage)
	read.mockImplementation(async ({ data }) =>
		activityPage(
			data.cursor ?? 'first',
			data.cursor === 'second' ? null : 'second',
		),
	)
	const client = new QueryClient()
	const href = activityInput('team-one', '?status=error&surface=execute')
	await loadActivityQuery(client, 'actor', href)
	const observer = new InfiniteQueryObserver(
		client,
		activityQuery('actor', href),
	)
	const unsubscribe = observer.subscribe(() => {})
	expect(read).toHaveBeenCalledTimes(1)
	await observer.fetchNextPage()
	expect(read).toHaveBeenCalledTimes(2)
	expect(read.mock.calls[1]?.[0].data).toEqual({ ...href, cursor: 'second' })
	expect(
		observer
			.getCurrentResult()
			.data?.pages.map((page) => page.payload.runs[0]?.id),
	).toEqual(['first', 'second'])
	expect(observer.getCurrentResult().hasNextPage).toBe(false)
	await loadActivityQuery(
		client,
		'actor',
		activityInput('team-two', '?status=error&surface=execute'),
	)
	expect(read).toHaveBeenCalledTimes(3)
	expect(observer.getCurrentResult().data?.pages).toHaveLength(2)
	unsubscribe()
	client.clear()
})

it('foreground entry cancels an old preload and rechecks revoked membership', async () => {
	const read = vi.mocked(loadActivityPage)
	read.mockReset()
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const href = activityInput('team-one', '')
	const cached = activityPage(null, null)
	client.setQueryData(activityQuery('actor', href).queryKey, {
		pages: [cached],
		pageParams: [null],
	})
	await client.invalidateQueries({
		queryKey: activityQuery('actor', href).queryKey,
	})
	let completeOldRead!: (value: typeof cached) => void
	read.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				completeOldRead = resolve
			}),
	)
	read.mockRejectedValueOnce(new Error('Membership revoked'))
	await loadActivityQuery(client, 'actor', href, true)
	await expect(loadActivityQuery(client, 'actor', href, false)).rejects.toThrow(
		'Membership revoked',
	)
	expect(read).toHaveBeenCalledTimes(2)
	expect(read.mock.calls[0]?.[0].signal?.aborted).toBe(true)
	completeOldRead(cached)
	client.clear()
})
