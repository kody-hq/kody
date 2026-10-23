import { expect, test } from 'vitest'
import {
	collectServerTiming,
	getRequestContext,
	memoizePerRequest,
	recordServerTiming,
	runWithRequestContext,
} from './request-context.ts'

function makeRequest() {
	return new Request('https://kody.test/@owner/demo')
}

test('memoizePerRequest loads once per key inside the request scope', async () => {
	const request = makeRequest()
	let loads = 0
	const load = () => {
		loads += 1
		return Promise.resolve(`value-${loads}`)
	}

	const results = await runWithRequestContext(request, () =>
		Promise.all([
			memoizePerRequest({ key: 'k', load }),
			memoizePerRequest({ key: 'k', load }),
			memoizePerRequest({ key: 'other', load }),
		]),
	)

	expect(results).toEqual(['value-1', 'value-1', 'value-2'])
	expect(loads).toBe(2)
})

test('an explicit request finds its context after the async scope has exited', async () => {
	const request = makeRequest()
	let loads = 0
	const load = async () => {
		loads += 1
		return loads
	}

	await runWithRequestContext(request, () =>
		memoizePerRequest({ request, key: 'k', load }),
	)
	// Streaming SSR frames run here: the store is gone but the request is not.
	expect(getRequestContext()).toBeUndefined()
	await expect(memoizePerRequest({ request, key: 'k', load })).resolves.toBe(1)
	expect(loads).toBe(1)
})

test('two requests never share a memo entry', async () => {
	let loads = 0
	const load = async () => {
		loads += 1
		return loads
	}
	const first = await runWithRequestContext(makeRequest(), () =>
		memoizePerRequest({ key: 'k', load }),
	)
	const second = await runWithRequestContext(makeRequest(), () =>
		memoizePerRequest({ key: 'k', load }),
	)
	expect([first, second]).toEqual([1, 2])
})

test('a rejected load is forgotten so the request can retry', async () => {
	const request = makeRequest()
	let attempts = 0
	const load = async () => {
		attempts += 1
		if (attempts === 1) throw new Error('flaky')
		return 'ok'
	}

	await runWithRequestContext(request, async () => {
		await expect(memoizePerRequest({ key: 'k', load })).rejects.toThrow('flaky')
		await expect(memoizePerRequest({ key: 'k', load })).resolves.toBe('ok')
	})
	expect(attempts).toBe(2)
})

test('recordServerTiming appends to the request entries and collectServerTiming merges', async () => {
	const request = makeRequest()
	await runWithRequestContext(request, async () => {
		await recordServerTiming('resolve-url', async () => 'x')
		await recordServerTiming('auth', async () => 'y', request)
	})

	const own = [{ name: 'highlight', durationMs: 3 }]
	const merged = collectServerTiming(request, own)
	expect(merged.map((entry) => entry.name)).toEqual([
		'resolve-url',
		'auth',
		'highlight',
	])
	// Passing the context's own array back does not duplicate it.
	const context = getRequestContext(request)
	expect(collectServerTiming(request, context?.serverTiming)).toHaveLength(2)
	expect(collectServerTiming(makeRequest())).toEqual([])
})
