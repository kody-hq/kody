import { afterEach, expect, test, vi } from 'vitest'
import {
	estimateRetainedBytes,
	PromiseLruCache,
	RetainedByteBudget,
} from './published-package-cache.ts'

afterEach(() => {
	vi.useRealTimers()
})

test('getOrCreate shares a settled value without calling create again', async () => {
	const cache = new PromiseLruCache<string>()
	const create = vi.fn(async () => 'built')
	await expect(cache.getOrCreate({ cacheKey: 'k', create })).resolves.toBe(
		'built',
	)
	await expect(cache.getOrCreate({ cacheKey: 'k', create })).resolves.toBe(
		'built',
	)
	expect(create).toHaveBeenCalledTimes(1)
})

test('a waiter on a live in-flight entry gets its value', async () => {
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 1_000 })
	let resolveFirst!: (value: string) => void
	const first = cache.getOrCreate({
		cacheKey: 'k',
		create: () =>
			new Promise<string>((resolve) => {
				resolveFirst = resolve
			}),
	})
	const secondCreate = vi.fn(async () => 'second')
	const second = cache.getOrCreate({ cacheKey: 'k', create: secondCreate })
	resolveFirst('first')
	await expect(first).resolves.toBe('first')
	await expect(second).resolves.toBe('first')
	expect(secondCreate).not.toHaveBeenCalled()
})

test('a waiter recovers from an orphaned in-flight entry that never settles', async () => {
	// A promise created by a request that ended (or was canceled) never
	// settles. Awaiting it alone left later requests hung (error code 1101).
	vi.useFakeTimers()
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 50 })
	void cache.getOrCreate({
		cacheKey: 'k',
		create: () => new Promise<string>(() => {}),
	})
	const recover = vi.fn(async () => 'rebuilt')
	const waiter = cache.getOrCreate({ cacheKey: 'k', create: recover })
	await vi.advanceTimersByTimeAsync(50)
	await expect(waiter).resolves.toBe('rebuilt')
	expect(recover).toHaveBeenCalledTimes(1)
	// The orphan is replaced, so the next request reuses the rebuilt value.
	const after = vi.fn(async () => 'unused')
	await expect(
		cache.getOrCreate({ cacheKey: 'k', create: after }),
	).resolves.toBe('rebuilt')
	expect(after).not.toHaveBeenCalled()
})

test("a waiter rebuilds when another request's in-flight entry rejects as ended", async () => {
	// With handle_cross_request_promise_resolution, awaiting a promise whose
	// request ended rejects the waiter, and the ended request never runs its
	// own eviction. Before, every later request got the same rejection until
	// the entry expired (Sentry 7850695233).
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 60_000 })
	const ended = new Error(
		'This promise was created by a request that has since ended, so it can never settle.',
	)
	let rejectOrphan!: (error: unknown) => void
	void cache.set(
		'k',
		new Promise<string>((_resolve, reject) => {
			rejectOrphan = reject
		}),
	)
	expect(cache.get('k')).toBeNull()
	const rebuild = vi.fn(async () => 'rebuilt')
	const waiter = cache.getOrCreate({ cacheKey: 'k', create: rebuild })
	rejectOrphan(ended)
	await expect(waiter).resolves.toBe('rebuilt')
	expect(rebuild).toHaveBeenCalledTimes(1)
	const after = vi.fn(async () => 'unused')
	await expect(
		cache.getOrCreate({ cacheKey: 'k', create: after }),
	).resolves.toBe('rebuilt')
	expect(after).not.toHaveBeenCalled()
	await expect(cache.get('k')).resolves.toBe('rebuilt')
})

test("a waiter retries another request's failed create once, then reports its own failure", async () => {
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 60_000 })
	let rejectFirst!: (error: unknown) => void
	const first = cache.getOrCreate({
		cacheKey: 'k',
		create: () =>
			new Promise<string>((_resolve, reject) => {
				rejectFirst = reject
			}),
	})
	const retry = vi.fn(async () => {
		throw new Error('still broken')
	})
	const waiter = cache.getOrCreate({ cacheKey: 'k', create: retry })
	rejectFirst(new Error('boom'))
	await expect(first).rejects.toThrow('boom')
	await expect(waiter).rejects.toThrow('still broken')
	expect(retry).toHaveBeenCalledTimes(1)
	await expect(
		cache.getOrCreate({ cacheKey: 'k', create: async () => 'ok' }),
	).resolves.toBe('ok')
})

test("a waiter whose shared rebuild also fails runs its own create instead of reporting another request's error", async () => {
	// Request A's entry rejects as ended, request C's rebuild is shared by
	// waiter B, then C ends too. B must not report C's failure.
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 60_000 })
	const ended = () =>
		new Error(
			'This promise was created by a request that has since ended, so it can never settle.',
		)
	let rejectOrphan!: (error: unknown) => void
	void cache.set(
		'k',
		new Promise<string>((_resolve, reject) => {
			rejectOrphan = reject
		}),
	)
	let rejectSharedRebuild!: (error: unknown) => void
	const otherRebuild = vi.fn(
		() =>
			new Promise<string>((_resolve, reject) => {
				rejectSharedRebuild = reject
			}),
	)
	const other = cache.getOrCreate({ cacheKey: 'k', create: otherRebuild })
	const ownCreate = vi.fn(async () => 'own')
	const waiter = cache.getOrCreate({ cacheKey: 'k', create: ownCreate })
	rejectOrphan(ended())
	await vi.waitFor(() => expect(otherRebuild).toHaveBeenCalledTimes(1))
	rejectSharedRebuild(ended())
	await expect(other).rejects.toThrow('request that has since ended')
	await expect(waiter).resolves.toBe('own')
	expect(ownCreate).toHaveBeenCalledTimes(1)
})

test('a waiter whose shared rebuild stalls runs its own create', async () => {
	vi.useFakeTimers()
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 50 })
	void cache.getOrCreate({
		cacheKey: 'k',
		create: () => new Promise<string>(() => {}),
	})
	const stalledRebuild = vi.fn(() => new Promise<string>(() => {}))
	void cache.getOrCreate({ cacheKey: 'k', create: stalledRebuild })
	await vi.advanceTimersByTimeAsync(20)
	const ownCreate = vi.fn(async () => 'own')
	const waiter = cache.getOrCreate({ cacheKey: 'k', create: ownCreate })
	await vi.advanceTimersByTimeAsync(30)
	expect(stalledRebuild).toHaveBeenCalledTimes(1)
	// The waiter times out on the orphan, shares the stalled rebuild, then
	// times out on that too.
	await vi.advanceTimersByTimeAsync(70)
	expect(ownCreate).toHaveBeenCalledTimes(1)
	await expect(waiter).resolves.toBe('own')
	expect(ownCreate).toHaveBeenCalledTimes(1)
})

test('a rejected create is evicted so the next call retries', async () => {
	const cache = new PromiseLruCache<string>()
	await expect(
		cache.getOrCreate({
			cacheKey: 'k',
			create: async () => {
				throw new Error('boom')
			},
		}),
	).rejects.toThrow('boom')
	await expect(
		cache.getOrCreate({ cacheKey: 'k', create: async () => 'ok' }),
	).resolves.toBe('ok')
})

test('waiters that time out later share the first rebuild instead of starting another', async () => {
	vi.useFakeTimers()
	const cache = new PromiseLruCache<string>({ inFlightWaitMs: 50 })
	void cache.getOrCreate({
		cacheKey: 'k',
		create: () => new Promise<string>(() => {}),
	})
	let resolveRebuild!: (value: string) => void
	const firstRecover = vi.fn(
		() =>
			new Promise<string>((resolve) => {
				resolveRebuild = resolve
			}),
	)
	const firstWaiter = cache.getOrCreate({
		cacheKey: 'k',
		create: firstRecover,
	})
	await vi.advanceTimersByTimeAsync(20)
	const secondRecover = vi.fn(async () => 'second')
	const secondWaiter = cache.getOrCreate({
		cacheKey: 'k',
		create: secondRecover,
	})
	// First waiter times out and starts the rebuild.
	await vi.advanceTimersByTimeAsync(30)
	expect(firstRecover).toHaveBeenCalledTimes(1)
	// Second waiter times out on the orphan while the rebuild is pending.
	await vi.advanceTimersByTimeAsync(20)
	expect(secondRecover).not.toHaveBeenCalled()
	resolveRebuild('rebuilt')
	await expect(firstWaiter).resolves.toBe('rebuilt')
	await expect(secondWaiter).resolves.toBe('rebuilt')
	expect(secondRecover).not.toHaveBeenCalled()
})

test('a shared byte budget evicts the least recently used entry across caches', async () => {
	const budget = new RetainedByteBudget(100)
	const first = new PromiseLruCache<string>({ byteBudget: budget })
	const second = new PromiseLruCache<string>({ byteBudget: budget })
	await first.getOrCreate({
		cacheKey: 'a',
		create: async () => 'x'.repeat(40),
	})
	await second.getOrCreate({
		cacheKey: 'b',
		create: async () => 'y'.repeat(40),
	})
	await first.getOrCreate({ cacheKey: 'a', create: async () => 'unused' })
	await second.getOrCreate({
		cacheKey: 'c',
		create: async () => 'z'.repeat(40),
	})
	expect(budget.retainedBytes).toBe(80)
	expect(first.get('a')).not.toBeNull()
	expect(second.get('b')).toBeNull()
	expect(second.get('c')).not.toBeNull()
})

test('a value bigger than the byte budget is returned but not cached', async () => {
	const budget = new RetainedByteBudget(10)
	const cache = new PromiseLruCache<string>({ byteBudget: budget })
	const create = vi.fn(async () => 'x'.repeat(11))
	await expect(
		cache.getOrCreate({ cacheKey: 'k', create }),
	).resolves.toHaveLength(11)
	expect(cache.get('k')).toBeNull()
	expect(budget.retainedBytes).toBe(0)
	await cache.getOrCreate({ cacheKey: 'k', create })
	expect(create).toHaveBeenCalledTimes(2)
})

test('expired, replaced, and entry-limit evictions release their bytes', async () => {
	vi.useFakeTimers()
	const budget = new RetainedByteBudget(1_000)
	const cache = new PromiseLruCache<string>({
		byteBudget: budget,
		limit: 1,
		ttlMs: 1_000,
	})
	await cache.getOrCreate({
		cacheKey: 'a',
		create: async () => 'x'.repeat(10),
	})
	await cache.getOrCreate({
		cacheKey: 'b',
		create: async () => 'y'.repeat(20),
	})
	expect(budget.retainedBytes).toBe(20)
	cache.set('b', Promise.resolve('z'.repeat(5)))
	await Promise.resolve()
	await Promise.resolve()
	expect(budget.retainedBytes).toBe(5)
	vi.advanceTimersByTime(1_001)
	expect(cache.get('b')).toBeNull()
	expect(budget.retainedBytes).toBe(0)
})

test('estimateRetainedBytes sizes strings and binaries in plain data only', () => {
	class Binding {
		readonly payload = 'x'.repeat(1_000)
	}
	expect(estimateRetainedBytes(new Binding())).toBe(0)
	expect(estimateRetainedBytes({ payload: 'x'.repeat(1_000) })).toBe(1_007)
	expect(
		estimateRetainedBytes({
			mainModule: 'main.js',
			modules: { 'main.js': 'a'.repeat(100) },
			bytes: new Uint8Array(50),
			binding: new Binding(),
		}),
	).toBe(193)
})
