import { dehydrate, QueryClient } from '@tanstack/react-query'
import { notFound, redirect } from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { shouldDehydrateAppQuery } from './query-dehydration.ts'

test('SSR retains success and streaming queries while Router failures stay local', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	client.setQueryData(['ready'], { title: 'Ready' })
	let finish!: (value: string) => void
	const pending = client.fetchQuery({
		queryKey: ['streaming'],
		queryFn: () =>
			new Promise<string>((resolve) => {
				finish = resolve
			}),
	})
	for (const failure of [redirect({ href: '/login' }), notFound()]) {
		await client.prefetchQuery({
			queryKey: ['failed', failure],
			queryFn: () => {
				throw failure
			},
		})
	}
	const snapshot = dehydrate(client, {
		shouldDehydrateQuery: shouldDehydrateAppQuery,
	})
	expect(snapshot.queries.map((query) => query.queryKey)).toEqual([
		['ready'],
		['streaming'],
	])
	expect(snapshot.queries[1]?.promise).toBeDefined()
	expect(
		client
			.getQueryCache()
			.getAll()
			.filter((query) => query.state.status === 'error'),
	).toHaveLength(2)
	finish('Streamed')
	await expect(pending).resolves.toBe('Streamed')
	client.clear()
})
