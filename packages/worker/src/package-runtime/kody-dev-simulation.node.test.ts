import { expect, test, vi } from 'vitest'
import {
	kodyDevClockOffsetMs,
	kodyDevClockShimSource,
	kodyDevColdIsolates,
	kodyDevStorageLatencyMs,
	withKodyDevStorageLatency,
	kodyDevOutboundFetch,
} from './kody-dev-simulation.ts'

const devStack = { KODY_DEV_MOCK_SECRETS: 'true' } as Env

test('simulations stay off outside the kody dev stack', () => {
	const production = {
		KODY_DEV_STORAGE_LATENCY_MS: '50',
		KODY_DEV_COLD_ISOLATES: 'true',
		KODY_DEV_CLOCK_OFFSET_MS: '1000',
	} as Env
	expect(kodyDevStorageLatencyMs(production)).toBe(0)
	expect(kodyDevColdIsolates(production)).toBe(false)
	expect(kodyDevClockOffsetMs(production)).toBe(0)
})

test('simulations read their vars on the kody dev stack', () => {
	const env = {
		...devStack,
		KODY_DEV_STORAGE_LATENCY_MS: '40',
		KODY_DEV_COLD_ISOLATES: 'true',
		KODY_DEV_CLOCK_OFFSET_MS: '-86400000',
	} as Env
	expect(kodyDevStorageLatencyMs(env)).toBe(40)
	expect(kodyDevColdIsolates(env)).toBe(true)
	expect(kodyDevClockOffsetMs(env)).toBe(-86400000)
	expect(
		kodyDevStorageLatencyMs({
			...devStack,
			KODY_DEV_STORAGE_LATENCY_MS: 'soon',
		} as Env),
	).toBe(0)
})

test('storage latency delays each call and keeps results', async () => {
	const calls: Array<string> = []
	const runner = {
		async get(key: string) {
			calls.push(key)
			return `value:${key}`
		},
	}
	const slow = withKodyDevStorageLatency(runner, 30)
	const startedAt = performance.now()
	await expect(slow.get('a')).resolves.toBe('value:a')
	expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25)
	expect(calls).toEqual(['a'])
})

test('clock shim shifts Date by the offset', () => {
	expect(kodyDevClockShimSource(0)).toBe('')
	const source = kodyDevClockShimSource(86_400_000)
	const realNow = Date.now()
	const shifted = new Function(
		`${source.replaceAll('globalThis.Date', 'scope.Date')}; return scope;`.replace(
			/^/,
			'const scope = { Date };',
		),
	)() as { Date: DateConstructor }
	expect(shifted.Date.now() - realNow).toBeGreaterThanOrEqual(86_400_000)
	expect(shifted.Date.now() - realNow).toBeLessThan(86_400_000 + 5_000)
	expect(new shifted.Date(0).getTime()).toBe(0)
	expect(new shifted.Date().getTime() - realNow).toBeGreaterThanOrEqual(
		86_400_000,
	)
})

test('outbound fetch goes to the kody dev mocks gateway only under the mock', async () => {
	const url = 'http://127.0.0.1:9/'
	expect(kodyDevOutboundFetch({ KODY_DEV_OUTBOUND_URL: url })).toBeNull()
	expect(kodyDevOutboundFetch({ KODY_DEV_MOCK_SECRETS: 'true' })).toBeNull()
	const gateway = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const sent = JSON.parse(String(init?.body))
		return Response.json({
			status: 201,
			statusText: 'Created',
			headers: { 'x-echo': sent.url },
			bodyBase64: btoa(`${sent.method} ${atob(sent.bodyBase64)}`),
		})
	})
	vi.stubGlobal('fetch', gateway)
	try {
		const outbound = kodyDevOutboundFetch({
			KODY_DEV_MOCK_SECRETS: 'true',
			KODY_DEV_OUTBOUND_URL: url,
		})!
		const response = await outbound('https://api.example.com/x', {
			method: 'POST',
			body: 'hi',
		})
		expect(gateway.mock.calls[0]![0]).toBe(url)
		expect(response.status).toBe(201)
		expect(response.headers.get('x-echo')).toBe('https://api.example.com/x')
		expect(await response.text()).toBe('POST hi')

		gateway.mockResolvedValueOnce(
			Response.json({ error: 'unmocked_request' }, { status: 502 }),
		)
		await expect(outbound('https://other.example.org/')).rejects.toThrow(
			'unmocked_request',
		)
	} finally {
		vi.unstubAllGlobals()
	}
})
