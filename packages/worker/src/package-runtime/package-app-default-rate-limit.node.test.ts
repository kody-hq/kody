import { expect, test } from 'vitest'
import {
	packageAppWriteRateLimitKey,
	refusePackageAppWriteOverRateLimit,
} from './package-app-default-rate-limit.ts'

function limiter(success: boolean) {
	const keys: Array<string> = []
	return {
		keys,
		binding: {
			async limit({ key }: { key: string }) {
				keys.push(key)
				return { success }
			},
		} as RateLimit,
	}
}

function post(headers: Record<string, string> = {}) {
	return new Request('https://alice.kody.run/app/save', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers },
	})
}

test('writes under the limit are served and counted per app and visitor IP', async () => {
	const { binding, keys } = limiter(true)
	const refusal = await refusePackageAppWriteOverRateLimit({
		request: post(),
		env: { PACKAGE_APP_RATE_LIMITER: binding },
		packageId: 'pkg-1',
		synthetic: false,
	})
	expect(refusal).toBeNull()
	expect(keys).toEqual([
		packageAppWriteRateLimitKey({ packageId: 'pkg-1', ip: '203.0.113.7' }),
	])
})

test('a write over the limit gets a 429 with Retry-After, as JSON for API callers', async () => {
	const { binding } = limiter(false)
	const text = await refusePackageAppWriteOverRateLimit({
		request: post(),
		env: { PACKAGE_APP_RATE_LIMITER: binding },
		packageId: 'pkg-1',
		synthetic: false,
	})
	expect(text?.status).toBe(429)
	expect(text?.headers.get('Retry-After')).toBe('60')
	expect(text?.headers.get('x-kody-default')).toBe('rate-limit')
	expect(await text?.text()).toContain('Wait a minute, then try again.')

	const json = await refusePackageAppWriteOverRateLimit({
		request: post({ Accept: 'application/json' }),
		env: { PACKAGE_APP_RATE_LIMITER: binding },
		packageId: 'pkg-1',
		synthetic: false,
	})
	expect(json?.status).toBe(429)
	expect(await json?.json()).toMatchObject({
		error: 'rate_limited',
		retry_after_seconds: 60,
	})
})

test('page loads, smoke fetches, and runtimes without the binding are not counted', async () => {
	const { binding, keys } = limiter(false)
	const env = { PACKAGE_APP_RATE_LIMITER: binding }
	expect(
		await refusePackageAppWriteOverRateLimit({
			request: new Request('https://alice.kody.run/app/', {
				headers: { 'CF-Connecting-IP': '203.0.113.7' },
			}),
			env,
			packageId: 'pkg-1',
			synthetic: false,
		}),
	).toBeNull()
	expect(
		await refusePackageAppWriteOverRateLimit({
			request: post(),
			env,
			packageId: 'pkg-1',
			synthetic: true,
		}),
	).toBeNull()
	expect(
		await refusePackageAppWriteOverRateLimit({
			request: post(),
			env: {},
			packageId: 'pkg-1',
			synthetic: false,
		}),
	).toBeNull()
	expect(keys).toEqual([])
})
