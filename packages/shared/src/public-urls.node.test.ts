import { expect, test } from 'vitest'
import {
	buildPackageAppCustomHostnamePath,
	buildPackageAppCustomHostnameUrl,
	buildPackageAppOpenPath,
	buildPackageAppPath,
	buildPackageAppSubdomainPath,
	buildPackagePagePath,
	dnsSafeUsernamePattern,
	dnsSafeUsernamePatternSource,
} from './public-urls.ts'

test('saved-package pages and hosted package-app mounts use different paths', () => {
	expect(
		buildPackagePagePath({ username: 'kentcdodds', kodyId: 'hn-pulse' }),
	).toBe('/@kentcdodds/hn-pulse')
	expect(
		buildPackageAppPath({ username: 'kentcdodds', kodyId: 'hn-pulse' }),
	).toBe('/@kentcdodds/packages/hn-pulse')
	expect(
		buildPackageAppPath({
			username: 'kentcdodds',
			kodyId: 'hn-pulse',
			restPath: '/report',
		}),
	).toBe('/@kentcdodds/packages/hn-pulse/report')
	expect(
		buildPackageAppOpenPath({ username: 'kentcdodds', kodyId: 'hn-pulse' }),
	).toBe('/@kentcdodds/packages/hn-pulse/open')
	expect(
		buildPackageAppOpenPath({
			username: 'kentcdodds',
			kodyId: 'hn-pulse',
			restPath: '/report',
		}),
	).toBe('/@kentcdodds/packages/hn-pulse/open/report')
	expect(buildPackageAppSubdomainPath({ kodyId: 'hn-pulse' })).toBe('/hn-pulse')
	expect(
		buildPackageAppSubdomainPath({ kodyId: 'hn-pulse', restPath: '/report' }),
	).toBe('/hn-pulse/report')
	expect(buildPackageAppCustomHostnamePath({})).toBe('/')
	expect(buildPackageAppCustomHostnamePath({ restPath: '/' })).toBe('/')
	expect(buildPackageAppCustomHostnamePath({ restPath: '/report' })).toBe(
		'/report',
	)
	expect(buildPackageAppCustomHostnamePath({ restPath: 'report' })).toBe(
		'/report',
	)
	expect(
		buildPackageAppCustomHostnameUrl({
			origin: 'https://app.customer.example/',
		}),
	).toBe('https://app.customer.example/')
	expect(
		buildPackageAppCustomHostnameUrl({
			origin: 'https://app.customer.example',
			restPath: '/report',
		}),
	).toBe('https://app.customer.example/report')
})

test('dns-safe handle source is the anchored pattern without a second copy', () => {
	expect(`^${dnsSafeUsernamePatternSource}$`).toBe(
		dnsSafeUsernamePattern.source,
	)
	expect(dnsSafeUsernamePattern.test('ab')).toBe(false)
	expect(dnsSafeUsernamePattern.test('abc')).toBe(true)
	expect(dnsSafeUsernamePattern.test('a-b')).toBe(true)
	expect(dnsSafeUsernamePattern.test('a'.repeat(32))).toBe(true)
	expect(dnsSafeUsernamePattern.test('a'.repeat(33))).toBe(false)
	expect(dnsSafeUsernamePattern.test('-ab')).toBe(false)
	expect(dnsSafeUsernamePattern.test('ab-')).toBe(false)
	expect(dnsSafeUsernamePattern.test('Ab1')).toBe(false)
	expect(dnsSafeUsernamePattern.test('a_b')).toBe(false)
})
