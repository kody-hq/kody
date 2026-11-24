import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
	createPageQuery,
	filteredPageQueryOptions,
	ensurePageQuery,
	freshAuthorizationWindowMs,
	loadPageQuery,
} from './page-query.ts'

const clients: QueryClient[] = []
function client() {
	const value = new QueryClient()
	clients.push(value)
	return value
}
afterEach(() => {
	for (const value of clients.splice(0)) value.clear()
	vi.useRealTimers()
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('page query ownership', () => {
	it('loads an invalidated resource independently of its pending write', async () => {
		const cache = client()
		const write = deferred<void>()
		const nextRead = deferred<{ title: string }>()
		const read = vi.fn(() => nextRead.promise)
		const options = createPageQuery('loadProfile', read)('actor-a', undefined)
		cache.setQueryData(options.queryKey, { title: 'Previous title' })
		const mutation = cache.getMutationCache().build(cache, {
			mutationKey: ['profile', 'actor-a'],
			mutationFn: () => write.promise,
		})
		const writing = mutation.execute(undefined)
		await cache.invalidateQueries({
			queryKey: options.queryKey,
			refetchType: 'none',
		})
		const navigation = ensurePageQuery(cache, options, false)
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
		nextRead.resolve({ title: 'Server title' })
		expect(await navigation).toEqual({ title: 'Server title' })
		expect(cache.isMutating()).toBe(1)
		write.resolve()
		await writing
	})

	it.each([false, true])(
		'authorizes independently of a pending write (cached: %s)',
		async (cached) => {
			const cache = client()
			const write = deferred<void>()
			const read = vi.fn(async () => ({ title: 'Server title' }))
			const options = createPageQuery('loadProfile', read, {
				freshAuthorization: cached,
			})('actor-a', undefined)
			if (cached) cache.setQueryData(options.queryKey, { title: 'Old title' })
			const mutation = cache.getMutationCache().build(cache, {
				mutationKey: ['profile', 'actor-a'],
				mutationFn: () => write.promise,
			})
			const writing = mutation.execute(undefined)
			expect(await ensurePageQuery(cache, options, false)).toEqual({
				title: 'Server title',
			})
			expect(read).toHaveBeenCalledTimes(1)
			expect(cache.isMutating()).toBe(1)
			write.resolve()
			await writing
		},
	)

	it('can require fresh authorization for protected inputs without disabling public reuse', async () => {
		const cache = client()
		const read = vi.fn(
			async ({
				data,
			}: {
				data: { restricted: boolean }
				signal: AbortSignal
			}) => data,
		)
		const options = createPageQuery('loadDoc', read, {
			freshAuthorization: (input) => input.restricted,
		})
		const publicDoc = options('actor', { restricted: false })
		const privateDoc = options('actor', { restricted: true })
		await ensurePageQuery(cache, publicDoc, false)
		await ensurePageQuery(cache, publicDoc, false)
		expect(read).toHaveBeenCalledTimes(1)
		vi.useFakeTimers()
		await ensurePageQuery(cache, privateDoc, false)
		vi.advanceTimersByTime(freshAuthorizationWindowMs)
		await ensurePageQuery(cache, privateDoc, false)
		expect(read).toHaveBeenCalledTimes(3)
	})

	it('accepts a permission read sent within the window, in flight or arrived', async () => {
		vi.useFakeTimers()
		const cache = client()
		const response = deferred<{ forbidden: boolean }>()
		const read = vi.fn(() => response.promise)
		const query = createPageQuery('loadAdminUsers', read, {
			freshAuthorization: true,
		})('same-actor', '/admin/users')
		const preload = ensurePageQuery(cache, query, true)
		vi.advanceTimersByTime(freshAuthorizationWindowMs - 1)
		const click = ensurePageQuery(cache, query, false)
		response.resolve({ forbidden: false })
		expect(await click).toEqual({ forbidden: false })
		await preload
		expect(await ensurePageQuery(cache, query, false)).toEqual({
			forbidden: false,
		})
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('measures the window from when the cached read was sent', async () => {
		vi.useFakeTimers()
		const cache = client()
		const read = vi.fn(async () => {
			await new Promise((done) => setTimeout(done, 100))
			return { forbidden: false }
		})
		const query = createPageQuery('loadAdminUsers', read, {
			freshAuthorization: true,
		})('same-actor', '/admin/users')
		const first = ensurePageQuery(cache, query, false)
		await vi.advanceTimersByTimeAsync(100)
		await first
		await vi.advanceTimersByTimeAsync(freshAuthorizationWindowMs - 101)
		await ensurePageQuery(cache, query, false)
		expect(read).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		const expired = ensurePageQuery(cache, query, false)
		await vi.advanceTimersByTimeAsync(100)
		await expired
		expect(read).toHaveBeenCalledTimes(2)
	})

	it('waits for a recent in-flight read instead of older cached data', async () => {
		vi.useFakeTimers()
		const cache = client()
		const slow = deferred<{ forbidden: boolean }>()
		const recheck = deferred<{ forbidden: boolean }>()
		const read = vi
			.fn<() => Promise<{ forbidden: boolean }>>()
			.mockReturnValueOnce(slow.promise)
			.mockReturnValueOnce(recheck.promise)
		const query = createPageQuery('loadAdminUsers', read, {
			freshAuthorization: true,
		})('same-actor', '/admin/users')
		const first = ensurePageQuery(cache, query, false)
		// The first response arrives late, so its data is new but its
		// authorization is not.
		await vi.advanceTimersByTimeAsync(freshAuthorizationWindowMs + 3_000)
		slow.resolve({ forbidden: false })
		await first
		await vi.advanceTimersByTimeAsync(1_000)
		const preload = ensurePageQuery(cache, query, true)
		await vi.advanceTimersByTimeAsync(1_000)
		const click = ensurePageQuery(cache, query, false)
		recheck.resolve({ forbidden: true })
		expect(await click).toEqual({ forbidden: true })
		await preload
		expect(read).toHaveBeenCalledTimes(2)
	})

	it('repeats an older permission read on preload so the click reuses it', async () => {
		vi.useFakeTimers()
		const cache = client()
		const read = vi.fn(async () => ({ forbidden: false }))
		const query = createPageQuery('loadAdminUsers', read, {
			freshAuthorization: true,
		})('same-actor', '/admin/users')
		await ensurePageQuery(cache, query, false)
		vi.advanceTimersByTime(freshAuthorizationWindowMs)
		await ensurePageQuery(cache, query, true)
		expect(read).toHaveBeenCalledTimes(2)
		await ensurePageQuery(cache, query, false)
		expect(read).toHaveBeenCalledTimes(2)
	})

	it('does not cancel an in-flight navigation read from a preload', async () => {
		vi.useFakeTimers()
		const cache = client()
		const response = deferred<{ forbidden: boolean }>()
		const read = vi.fn(() => response.promise)
		const query = createPageQuery('loadAdminUsers', read, {
			freshAuthorization: true,
		})('same-actor', '/admin/users')
		const navigation = ensurePageQuery(cache, query, false)
		vi.advanceTimersByTime(freshAuthorizationWindowMs)
		const preload = ensurePageQuery(cache, query, true)
		response.resolve({ forbidden: false })
		expect(await navigation).toEqual({ forbidden: false })
		expect(await preload).toEqual({ forbidden: false })
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('rechecks an invalidated permission read even within the window', async () => {
		const cache = client()
		const read = vi.fn(async () => ({ forbidden: false }))
		const query = createPageQuery('loadAdminUsers', read, {
			freshAuthorization: true,
		})('same-actor', '/admin/users')
		await ensurePageQuery(cache, query, true)
		await cache.invalidateQueries({
			queryKey: query.queryKey,
			refetchType: 'none',
		})
		await ensurePageQuery(cache, query, false)
		expect(read).toHaveBeenCalledTimes(2)
	})
	it('hovering a link back to the page on screen starts no read', async () => {
		vi.useFakeTimers()
		const cache = client()
		const read = vi.fn(async () => ({ forbidden: false }))
		const query = createPageQuery('loadSkills', read, {
			freshAuthorization: true,
		})('same-actor', '/skills')
		await ensurePageQuery(cache, query, false)
		const unsubscribe = new QueryObserver(cache, query).subscribe(() => {})
		vi.advanceTimersByTime(freshAuthorizationWindowMs)
		await ensurePageQuery(cache, query, true)
		expect(read).toHaveBeenCalledTimes(1)
		unsubscribe()
		await ensurePageQuery(cache, query, true)
		expect(read).toHaveBeenCalledTimes(2)
	})
	it('awaits an explicitly invalidated revision so Router metadata cannot reuse the old title', async () => {
		const cache = client()
		const next = deferred<{ title: string }>()
		const read = vi.fn(() => next.promise)
		const options = createPageQuery('loadProfile', read)('actor-a', undefined)
		cache.setQueryData(options.queryKey, { title: 'Old title' })
		await cache.invalidateQueries({
			queryKey: options.queryKey,
			refetchType: 'none',
		})
		let settled = false
		const loading = ensurePageQuery(cache, options, false).then((value) => {
			settled = true
			return value
		})
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
		expect(settled).toBe(false)
		next.resolve({ title: 'New title' })
		expect(await loading).toEqual({ title: 'New title' })
	})
	it('reuses fresh data and returns stale data before its background read completes', async () => {
		const cache = client()
		const next = deferred<{ revision: number }>()
		const read = vi.fn(() => next.promise)
		const options = createPageQuery('loadDoc', read, { staleTime: 60_000 })
		const query = options(null, undefined)
		cache.setQueryData(query.queryKey, { revision: 1 })
		expect(await ensurePageQuery(cache, query, false)).toEqual({ revision: 1 })
		expect(read).not.toHaveBeenCalled()
		cache.setQueryData(
			query.queryKey,
			{ revision: 1 },
			{ updatedAt: Date.now() - 61_000 },
		)
		expect(await ensurePageQuery(cache, query, false)).toEqual({ revision: 1 })
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
		expect(cache.getQueryState(query.queryKey)?.fetchStatus).toBe('fetching')
		next.resolve({ revision: 2 })
		await vi.waitFor(() =>
			expect(cache.getQueryData(query.queryKey)).toEqual({ revision: 2 }),
		)
	})

	it('keeps another actor and another resource selection out of a warm page cache', async () => {
		const cache = client()
		let revision = 0
		const read = vi.fn(
			async ({ data }: { data: { id: string }; signal: AbortSignal }) => ({
				id: data.id,
				revision: ++revision,
			}),
		)
		const options = createPageQuery('loadDetail', read)
		const first = await cache.ensureQueryData(options('actor-a', { id: 'one' }))
		const secondActor = await cache.ensureQueryData(
			options('actor-b', { id: 'one' }),
		)
		const secondItem = await cache.ensureQueryData(
			options('actor-a', { id: 'two' }),
		)
		expect(secondActor).not.toEqual(first)
		expect(secondItem.id).toBe('two')
		expect(
			await cache.ensureQueryData(options('actor-a', { id: 'one' })),
		).toEqual(first)
		expect(read).toHaveBeenCalledTimes(3)
	})

	it('shares an in-flight preload with the foreground consumer', async () => {
		const cache = client()
		const response = deferred<{ title: string }>()
		const read = vi.fn(({ signal }: { data: string; signal: AbortSignal }) => {
			expect(signal.aborted).toBe(false)
			return response.promise
		})
		const options = createPageQuery('loadDoc', read)
		const preload = cache.ensureQueryData(options(null, 'secrets'))
		const navigation = cache.ensureQueryData(options(null, 'secrets'))
		response.resolve({ title: 'Secrets' })
		expect(await preload).toEqual(await navigation)
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('cancels a stale read before an optimistic write and rejects its late result', async () => {
		const cache = client()
		const response = deferred<{ title: string }>()
		let transportSignal: AbortSignal | undefined
		const options = createPageQuery(
			'loadDoc',
			({ signal }: { data: string; signal: AbortSignal }) => {
				transportSignal = signal
				// Model a transport whose response wins the physical abort race.
				return response.promise
			},
		)
		const query = options('actor-a', 'draft')
		const read = cache.ensureQueryData(query)
		const observed = read.catch((error: unknown) => error)
		await cache.cancelQueries({ queryKey: query.queryKey, exact: true })
		expect(transportSignal?.aborted).toBe(true)
		cache.setQueryData(query.queryKey, { title: 'New title' })
		response.resolve({ title: 'Old title' })
		await observed
		await Promise.resolve()
		expect(cache.getQueryData(query.queryKey)).toEqual({ title: 'New title' })
	})
	it('rechecks changed permissions instead of accepting an older in-flight preload', async () => {
		vi.useFakeTimers()
		const cache = client()
		const oldResponse = deferred<{ forbidden: boolean }>()
		const started = deferred<void>()
		let readCount = 0
		let oldSignal: AbortSignal | undefined
		const options = createPageQuery(
			'loadAdminUsers',
			({ signal }: { data: string; signal: AbortSignal }) => {
				if (++readCount === 1) {
					oldSignal = signal
					started.resolve()
					return oldResponse.promise
				}
				return Promise.resolve({ forbidden: true })
			},
			{ freshAuthorization: true },
		)
		const query = options('same-actor', '/admin/users')
		const preload = ensurePageQuery(cache, query, true).catch(
			(error: unknown) => error,
		)
		await started.promise
		vi.advanceTimersByTime(freshAuthorizationWindowMs)
		expect(await ensurePageQuery(cache, query, false)).toEqual({
			forbidden: true,
		})
		expect(oldSignal?.aborted).toBe(true)
		oldResponse.resolve({ forbidden: false })
		await preload
		expect(cache.getQueryData(query.queryKey)).toEqual({ forbidden: true })
		expect(readCount).toBe(2)
	})
})

it('uses the QueryClient retry policy for transient reads', async () => {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
	})
	let attempts = 0
	const read = vi.fn(async () => {
		if (++attempts === 1) throw new Error('Temporary network failure')
		return { title: 'Recovered' }
	})
	try {
		const options = createPageQuery('loadDoc', read)(null, undefined)
		expect(await ensurePageQuery(cache, options, false)).toEqual({
			title: 'Recovered',
		})
		expect(read).toHaveBeenCalledTimes(2)
	} finally {
		cache.clear()
	}
})

it('leaves route metadata ownership intact for shared resources without a head', async () => {
	const cache = client()
	const account = createPageQuery('loadAccountPage', async () => ({
		payloads: { displayName: 'Pat' },
	}))('actor-a', '')
	expect(await loadPageQuery(cache, account, false)).toEqual({
		head: undefined,
	})
	const head = { title: 'Package name' }
	const detail = createPageQuery('loadPackage', async () => ({ head }))(
		'actor-a',
		'package',
	)
	expect(await loadPageQuery(cache, detail, false)).toEqual({
		head,
		pageHeadQueryKey: detail.queryKey,
	})
})

it('filter observers retain rows only within the same account and mounted resource, and reuse cached filters', async () => {
	const cache = client()
	const waiting = deferred<{ rows: string[] }>()
	const read = vi.fn(
		async ({ data }: { data: { q: string }; signal: AbortSignal }) =>
			data.q === 'slow' ? waiting.promise : { rows: [data.q] },
	)
	const query = createPageQuery('filtered-list', read)
	const first = filteredPageQueryOptions(query('actor-a', { q: 'first' }), [
		'actor-a',
		'org-a',
	])
	await cache.fetchQuery(first)
	const observer = new QueryObserver(cache, first)
	const unsubscribe = observer.subscribe(() => {})
	observer.setOptions(
		filteredPageQueryOptions(query('actor-a', { q: 'slow' }), [
			'actor-a',
			'org-a',
		]),
	)
	expect(observer.getCurrentResult().data).toEqual({ rows: ['first'] })
	expect(observer.getCurrentResult().isPlaceholderData).toBe(true)
	observer.setOptions(
		filteredPageQueryOptions(query('actor-a', { q: 'slow' }), [
			'actor-a',
			'org-b',
		]),
	)
	expect(observer.getCurrentResult().data).toBeUndefined()
	observer.setOptions(
		filteredPageQueryOptions(query('actor-b', { q: 'slow' }), [
			'actor-b',
			'org-b',
		]),
	)
	expect(observer.getCurrentResult().data).toBeUndefined()
	observer.setOptions(first)
	expect(observer.getCurrentResult().data).toEqual({ rows: ['first'] })
	expect(
		read.mock.calls.filter(([input]) => input.data.q === 'first'),
	).toHaveLength(1)
	waiting.resolve({ rows: ['slow'] })
	unsubscribe()
	observer.destroy()
	cache.clear()
})
