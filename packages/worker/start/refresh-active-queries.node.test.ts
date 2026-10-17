import {
	QueryClient,
	QueryObserver,
	type QueryKey,
} from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { refreshActiveQueries } from './refresh-active-queries.ts'

const clients: QueryClient[] = []
const unsubscribes: Array<() => void> = []
afterEach(() => {
	unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe())
	clients.splice(0).forEach((client) => client.clear())
})

function setup() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	clients.push(client)
	function query(
		queryKey: QueryKey,
		{ active = true, stale = false, freshAuthorization = false } = {},
	) {
		const read = vi.fn(async () => 'updated')
		const options = {
			queryKey,
			queryFn: read,
			staleTime: stale ? 0 : 60_000,
			meta: {
				freshAuthorization,
				...(queryKey[0] === 'other' ? {} : { actorKey: queryKey[1] }),
			},
		}
		client.setQueryData(queryKey, 'cached')
		if (active) {
			const observer = new QueryObserver(client, {
				...options,
				refetchOnMount: false,
			})
			unsubscribes.push(observer.subscribe(() => {}))
		}
		return read
	}
	return { client, query }
}

test('activation respects active freshness and leaves inactive revisits reusable', async () => {
	const { client, query } = setup()
	const fresh = query(['page', 'a', 'fresh'])
	const shell = query(['shell', 'a', ''])
	const stale = query(['page', 'a', 'stale'], { stale: true })
	const inactiveKey = ['page', 'a', 'inactive']
	const inactive = query(inactiveKey, { active: false, stale: true })
	const otherActor = query(['page', 'b', 'stale'], { stale: true })
	const unrelated = query(['other', 'a'], { stale: true })
	const verify = vi.fn(async () => {})
	await refreshActiveQueries(client, 'a', verify)
	expect(verify).toHaveBeenCalledTimes(1)
	expect(stale).toHaveBeenCalledTimes(1)
	for (const read of [fresh, shell, inactive, otherActor, unrelated])
		expect(read).not.toHaveBeenCalled()
	expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(false)
	expect(client.getQueryData(inactiveKey)).toBe('cached')
})

test('permission-sensitive pages recheck even when fresh', async () => {
	const { client, query } = setup()
	const page = query(['page', 'a', 'private'], { freshAuthorization: true })
	const video = query(['shell', 'a', '?youtubeId=video'])
	await refreshActiveQueries(client, 'a', async () => {})
	expect(page).toHaveBeenCalledTimes(1)
	expect(video).not.toHaveBeenCalled()
})

test('activation computes elapsed age without relying on an observer stale timer', async () => {
	const { client, query } = setup()
	const read = query(['page', 'a', 'timed'])
	const now = Date.now()
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
	try {
		// Advancing wall-clock time alone models a throttled background tab.
		expect(
			client
				.getQueryCache()
				.find({ queryKey: ['page', 'a', 'timed'] })
				?.isStale(),
		).toBe(false)
		await refreshActiveQueries(client, 'a', async () => {})
		expect(read).toHaveBeenCalledTimes(1)
	} finally {
		clock.mockRestore()
	}
})

test('activation honors static, infinite and disabled observers and functional freshness', async () => {
	const { client } = setup()
	const reads = []
	for (const [name, staleTime, enabled] of [
		['static', 'static', true],
		['infinite', Infinity, true],
		['disabled', 0, false],
		['functional', () => 0, () => true],
	] as const) {
		const queryKey = ['page', 'a', name]
		const read = vi.fn(async () => 'updated')
		reads.push(read)
		client.setQueryData(queryKey, 'cached')
		const observer = new QueryObserver(client, {
			queryKey,
			queryFn: read,
			staleTime,
			enabled,
			meta: { actorKey: 'a' },
			refetchOnMount: false,
		})
		unsubscribes.push(observer.subscribe(() => {}))
	}
	await refreshActiveQueries(client, 'a', async () => {})
	expect(reads.map((read) => read.mock.calls.length)).toEqual([0, 0, 0, 1])
})

test('no resource read starts before actor verification or after it fails', async () => {
	const { client, query } = setup()
	const read = query(['page', 'a', 'private'], { stale: true })
	let release!: () => void
	const verification = new Promise<void>((resolve) => {
		release = resolve
	})
	const refresh = refreshActiveQueries(client, 'a', () => verification)
	await Promise.resolve()
	expect(read).not.toHaveBeenCalled()
	release()
	await refresh
	expect(read).toHaveBeenCalledTimes(1)
	const failure = new Error('The document actor changed')
	await expect(
		refreshActiveQueries(client, 'a', async () => {
			throw failure
		}),
	).rejects.toBe(failure)
	expect(read).toHaveBeenCalledTimes(1)
})

test('domain resources refresh after identity verification without a page-name registry', async () => {
	const { client, query } = setup()
	const list = query(['email', 'a', 'team', 'list'], { stale: true })
	const destinations = query(['email-destinations', 'a'], { stale: true })
	const anotherActor = query(['email', 'b', 'team', 'list'], { stale: true })
	await refreshActiveQueries(client, 'a', async () => {})
	expect(list).toHaveBeenCalledTimes(1)
	expect(destinations).toHaveBeenCalledTimes(1)
	expect(anotherActor).not.toHaveBeenCalled()
})
