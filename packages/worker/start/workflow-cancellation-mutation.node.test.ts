import {
	MutationObserver,
	QueryClient,
	QueryObserver,
} from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { workflowCancellationMutationOptions } from './workflow-cancellation-mutation.ts'
import { createPageQuery } from './page-query.ts'

const scope = { actorKey: 'actor', orgSlug: 'submitted-org' }
const key = [
	'page',
	scope.actorKey,
	'loadWorkflowsPage',
	{ orgSlug: scope.orgSlug },
] as const
const running = { status: 'running' }
const cancelled = { status: 'cancelled' }

for (const active of [true, false]) {
	test.each(['accepted', 'lost response'] as const)(
		`cancellation preserves uncached navigation and confirms %s, active observer: ${active}`,
		async (outcome) => {
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			})
			let finishRead!: (value: typeof running) => void
			let finishWrite!: () => void
			let failWrite!: (error: Error) => void
			const read = vi.fn<() => Promise<typeof running>>()
			read.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishRead = resolve
					}),
			)
			read.mockResolvedValue(cancelled)
			const mutation = new MutationObserver(client, {
				mutationKey: ['workflows', scope.actorKey, scope.orgSlug],
				...workflowCancellationMutationOptions(
					client,
					async (_input: typeof scope) =>
						new Promise<void>((resolve, reject) => {
							finishWrite = resolve
							failWrite = reject
						}),
				),
			})
			const write = mutation.mutate(scope).catch(() => undefined)
			await vi.waitFor(() => expect(finishWrite).toBeDefined())
			const options = createPageQuery('loadWorkflowsPage', read, {
				staleTime: Infinity,
			})(scope.actorKey, { orgSlug: scope.orgSlug })
			const navigation = client.ensureQueryData(options)
			const observer = new QueryObserver(client, options)
			const stop = active ? observer.subscribe(() => {}) : () => {}
			// Reads must run while cancellation is pending, without the old barrier.
			await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
			const otherActor = [
				'page',
				'next-actor',
				'loadWorkflowsPage',
				{ orgSlug: scope.orgSlug },
			]
			const otherOrg = [
				'page',
				scope.actorKey,
				'loadWorkflowsPage',
				{ orgSlug: 'next-org' },
			]
			client.setQueryData(otherActor, running)
			client.setQueryData(otherOrg, running)
			if (outcome === 'accepted') finishWrite()
			else failWrite(new Error('Lost response after commit'))
			await Promise.resolve()
			expect(mutation.getCurrentResult().isPending).toBe(true)
			finishRead(running)
			await expect(navigation).resolves.toEqual(running)
			await write
			expect(read).toHaveBeenCalledTimes(2)
			expect(client.getQueryData(key)).toEqual(cancelled)
			expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
			expect(client.getQueryState(otherOrg)?.isInvalidated).toBe(false)
			expect(mutation.getCurrentResult().isPending).toBe(false)
			stop()
			client.clear()
		},
	)
}

test('cancellation replaces an older cached background read and invalidates waiting and activity in the submitted scope', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	client.setQueryData(key, running)
	let finishOld!: (value: typeof running) => void
	const read = vi.fn<() => Promise<typeof running>>()
	read.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishOld = resolve
			}),
	)
	read.mockResolvedValue(cancelled)
	const observer = new QueryObserver(client, { queryKey: key, queryFn: read })
	const stop = observer.subscribe(() => {})
	await vi.waitFor(() => expect(finishOld).toBeDefined())
	const waiting = [
		'page',
		scope.actorKey,
		'loadWaitingPage',
		{ orgSlug: scope.orgSlug },
	]
	const activity = [
		'page',
		scope.actorKey,
		'loadActivityPage',
		{ orgSlug: scope.orgSlug },
	]
	client.setQueryData(waiting, running)
	client.setQueryData(activity, running)
	const mutation = new MutationObserver(
		client,
		workflowCancellationMutationOptions(
			client,
			async (_input: typeof scope) => {},
		),
	)
	await mutation.mutate(scope)
	finishOld(running)
	await Promise.resolve()
	expect(read).toHaveBeenCalledTimes(2)
	expect(client.getQueryData(key)).toEqual(cancelled)
	expect(client.getQueryState(waiting)?.isInvalidated).toBe(true)
	expect(client.getQueryState(activity)?.isInvalidated).toBe(true)
	stop()
	client.clear()
})
