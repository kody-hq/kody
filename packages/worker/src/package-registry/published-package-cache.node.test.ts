import { afterEach, expect, test, vi } from 'vitest'
import { PromiseLruCache } from './published-package-cache.ts'

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
