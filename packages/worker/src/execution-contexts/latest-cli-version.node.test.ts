import { afterEach, expect, test } from 'vitest'
import { isOlderCliVersion } from '#universal/execution-contexts.ts'
import {
	latestCliVersion,
	resetLatestCliVersionCache,
} from './latest-cli-version.ts'

afterEach(() => resetLatestCliVersionCache())

test('isOlderCliVersion compares x.y.z numerically', () => {
	expect(isOlderCliVersion('1.9.0', '1.10.0')).toBe(true)
	expect(isOlderCliVersion('1.10.0', '1.10.0')).toBe(false)
	expect(isOlderCliVersion('2.0.0', '1.99.9')).toBe(false)
	expect(isOlderCliVersion('0.0.0-semantically-released', '1.0.0')).toBe(true)
	expect(isOlderCliVersion('1.52.0-rc.1', '1.52.0')).toBe(true)
	expect(isOlderCliVersion('1.52.0', '1.52.0-rc.1')).toBe(false)
	expect(isOlderCliVersion('1.52.0+build.5', '1.52.0')).toBe(false)
})

test('latestCliVersion caches the registry answer and survives failures', async () => {
	let calls = 0
	const ok = (async () => {
		calls++
		return Response.json({ version: '1.52.0' })
	}) as unknown as typeof fetch
	expect(await latestCliVersion(ok, 0)).toBe('1.52.0')
	expect(await latestCliVersion(ok, 1000)).toBe('1.52.0')
	expect(calls).toBe(1)

	resetLatestCliVersionCache()
	const broken = (async () => {
		throw new Error('offline')
	}) as unknown as typeof fetch
	expect(await latestCliVersion(broken, 0)).toBeNull()
	expect(await latestCliVersion(ok, 1000)).toBeNull()
	expect(await latestCliVersion(ok, 10 * 60 * 1000)).toBe('1.52.0')
})
