import { expect, test } from 'vitest'
import {
	buildPackageAppCustomHostnamePath,
	buildPackageAppCustomHostnameUrl,
	buildPackageAppOpenPath,
	buildPackageAppPath,
	buildPackageAppSubdomainPath,
	buildPackagePagePath,
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
	expect(buildPackageAppSubdomainPath({ kodyId: 'hn-pulse' })).toBe('/hn-pulse')
	// Reserved / non-leaf leaves cannot use the short path; serving needs the
	// legacy `/packages/{leaf}` mount (bare `/packages` has no leaf; `/robots.txt`
	// is a host root file).
	expect(buildPackageAppSubdomainPath({ kodyId: 'packages' })).toBe(
		'/packages/packages',
	)
	expect(buildPackageAppSubdomainPath({ kodyId: 'robots.txt' })).toBe(
		'/packages/robots.txt',
	)
	expect(buildPackageAppCustomHostnamePath({})).toBe('/')
	expect(
		buildPackageAppCustomHostnameUrl({
			origin: 'https://app.customer.example/',
		}),
	).toBe('https://app.customer.example/')
})
