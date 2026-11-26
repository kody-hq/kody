import { afterEach, expect, test, vi } from 'vitest'
import { promiseLruCacheInFlightWaitMs } from '#worker/package-registry/published-package-cache.ts'
import { isolateMemo, isolateMemoByKey } from './isolate-memo.ts'

afterEach(() => {
	vi.useRealTimers()
})

const endedRequestError = new Error(
	'This promise was created by a request that has since ended, so it can never settle.',
)

/** Loads that settle only when the test says so, like an import whose request ended. */
function controlledLoads() {
	const loads: Array<PromiseWithResolvers<{ id: number }>> = []
	return {
		loads,
		load: vi.fn(() => {
			const next = Promise.withResolvers<{ id: number }>()
			loads.push(next)
			return next.promise
		}),
	}
}

test('a load from an ended request is not reused: the later caller loads on its own', async () => {
	const { loads, load } = controlledLoads()
	const memo = isolateMemo(load)
	void memo().catch(() => {})
	const later = memo()
	// workerd rejects a waiter on a promise whose request ended.
	loads[0]!.reject(endedRequestError)
	await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
	loads[1]!.resolve({ id: 2 })
	await expect(later).resolves.toEqual({ id: 2 })
})

test('a load that never settles is taken over by a later caller', async () => {
	vi.useFakeTimers()
	const { loads, load } = controlledLoads()
	const memo = isolateMemo(load)
	void memo()
	const later = memo()
	await vi.advanceTimersByTimeAsync(promiseLruCacheInFlightWaitMs)
	expect(load).toHaveBeenCalledTimes(2)
	loads[1]!.resolve({ id: 2 })
	await expect(later).resolves.toEqual({ id: 2 })
})

test('a settled value is reused and a failed load is retried', async () => {
	let calls = 0
	const memo = isolateMemo(async () => {
		calls += 1
		if (calls === 1) throw new Error('load failed')
		return { id: calls }
	})
	await expect(memo()).rejects.toThrow('load failed')
	const value = await memo()
	expect(value).toEqual({ id: 2 })
	expect(await memo()).toBe(value)
	expect(calls).toBe(2)
})

test('keyed memos load once per key and clear', async () => {
	const load = vi.fn(async (key: string) => ({ key }))
	const memo = isolateMemoByKey(load)
	expect(await memo('a')).toBe(await memo('a'))
	await memo('b')
	expect(load).toHaveBeenCalledTimes(2)
	memo.clear()
	await memo('a')
	expect(load).toHaveBeenCalledTimes(3)
})
