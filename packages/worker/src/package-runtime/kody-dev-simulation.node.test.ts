import { expect, test } from 'vitest'
import {
	kodyDevClockOffsetMs,
	kodyDevClockShimSource,
	kodyDevColdIsolates,
	kodyDevStorageLatencyMs,
	withKodyDevStorageLatency,
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
