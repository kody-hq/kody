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
	expect(
		estimateRetainedBytes({
			mainModule: 'main.js',
			modules: { 'main.js': 'a'.repeat(100) },
			bytes: new Uint8Array(50),
			binding: new Binding(),
		}),
	).toBe(
		'mainModule'.length +
			'main.js'.length +
			'modules'.length +
			'main.js'.length +
			100 +
			'bytes'.length +
			50 +
			'binding'.length,
	)
})
