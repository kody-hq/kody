import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
	createPageQuery,
	ensurePageQuery,
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
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('page query ownership', () => {
	it.each([
		['loadAccountPage', 'profile'],
		['loadProfile', 'profile'],
		['loadJobsPage', 'jobs'],
	])(
		'loads an invalidated %s independently of its pending write',
		async (resource, mutationName) => {
			const cache = client()
			const write = deferred<void>()
			const nextRead = deferred<{ title: string }>()
			const read = vi.fn(() => nextRead.promise)
			const options = createPageQuery(resource, read)('actor-a', undefined)
			cache.setQueryData(options.queryKey, { title: 'Previous title' })
			const mutation = cache.getMutationCache().build(cache, {
				mutationKey: [mutationName, 'actor-a'],
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
		},
	)

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
		await ensurePageQuery(cache, privateDoc, false)
		await ensurePageQuery(cache, privateDoc, false)
		expect(read).toHaveBeenCalledTimes(3)
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
