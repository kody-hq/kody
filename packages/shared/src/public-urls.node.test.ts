import { expect, test } from 'vitest'
import {
	buildPackageAppCustomHostnamePath,
	buildPackageAppCustomHostnameUrl,
	buildPackageAppHostOrigin,
	buildPackageAppOpenPath,
	buildPackageAppPath,
	buildPackageAppRootOrigin,
	buildPackageAppSubdomainPath,
	buildPackagePagePath,
	parsePackageAppHostLabel,
	resolveHostedPackageAppLocation,
	resolveHostedPackageAppUrl,
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

test('per-app host labels split into leaf and handle, and build the app origin', () => {
	expect(parsePackageAppHostLabel('hn-pulse--kentcdodds')).toEqual({
		leaf: 'hn-pulse',
		handle: 'kentcdodds',
	})
	const longest = `${'a'.repeat(29)}--${'b'.repeat(32)}`
	expect(longest).toHaveLength(63)
	expect(parsePackageAppHostLabel(longest)).toEqual({
		leaf: 'a'.repeat(29),
		handle: 'b'.repeat(32),
	})
	for (const label of [
		`${'a'.repeat(30)}--${'b'.repeat(32)}`,
		'kentcdodds',
		'xn--kentcdodds',
		'--kentcdodds',
		'demo--',
		'demo--a--kentcdodds',
		'demo---kentcdodds',
		'-demo--kentcdodds',
		'Demo--kentcdodds',
		'demo--xy',
	]) {
		expect({ label, parsed: parsePackageAppHostLabel(label) }).toEqual({
			label,
			parsed: null,
		})
	}
	expect(
		buildPackageAppHostOrigin({
			packageAppOrigin: 'http://localhost:8788',
			username: 'KentCDodds',
			kodyId: 'hn-pulse',
		}),
	).toBe('http://hn-pulse--kentcdodds.localhost:8788')
	// A legacy leaf with no valid host label has no app host.
	expect(
		buildPackageAppHostOrigin({
			packageAppOrigin: 'https://kody.run',
			username: 'kentcdodds',
			kodyId: 'hn_pulse',
		}),
	).toBeNull()
})

test('a profile package is addressed at the root of its owner host', () => {
	expect(
		buildPackageAppRootOrigin({
			packageAppOrigin: 'https://kody.run',
			username: 'Kody',
			kodyId: 'kody',
		}),
	).toBe('https://kody.kody.run')
	expect(
		buildPackageAppRootOrigin({
			packageAppOrigin: 'https://kody.run',
			username: 'kody',
			kodyId: 'newsletter',
		}),
	).toBe('https://newsletter--kody.kody.run')
	expect(
		resolveHostedPackageAppUrl({
			packageAppBaseUrl: 'http://localhost:8788',
			appBaseUrl: 'http://localhost:3742',
			username: 'kody',
			kodyId: 'kody',
			restPath: '/newsletter/unsubscribe',
		}),
	).toBe('http://kody.localhost:8788/newsletter/unsubscribe')
})

test('every package app links to its own host, never the shared owner host path address', () => {
	const hostedUrl = resolveHostedPackageAppUrl({
		packageAppBaseUrl: 'https://kody.run',
		appBaseUrl: 'https://kody.codes',
		username: 'kentcdodds',
		kodyId: 'mailroom',
		restPath: '/inbox',
	})
	expect(hostedUrl).toBe('https://mailroom--kentcdodds.kody.run/inbox')
	// The old shapes: `{user}.kody.run/{app}` and `{user}.kody.run/packages/{app}`.
	expect(hostedUrl).not.toMatch(/^https:\/\/kentcdodds\.kody\.run\//)
	expect(hostedUrl).not.toContain('/packages/')
	// A leaf with no valid host label keeps the only address that routes.
	expect(
		resolveHostedPackageAppUrl({
			packageAppBaseUrl: 'https://kody.run',
			appBaseUrl: 'https://kody.codes',
			username: 'kentcdodds',
			kodyId: 'Legacy_App',
		}),
	).toBe('https://kentcdodds.kody.run/Legacy_App')
	expect(
		resolveHostedPackageAppUrl({
			packageAppBaseUrl: null,
			appBaseUrl: 'https://preview.kody.codes',
			username: 'kentcdodds',
			kodyId: 'mailroom',
		}),
	).toBe('https://preview.kody.codes/@kentcdodds/packages/mailroom')
})

test('inline package app mount excludes the request subpath', () => {
	expect(
		resolveHostedPackageAppLocation({
			packageAppBaseUrl: null,
			appBaseUrl: 'https://preview.kody.codes',
			username: 'jane',
			kodyId: 'mailroom',
			restPath: '/inbox',
		}),
	).toEqual({
		hostedUrl: 'https://preview.kody.codes/@jane/packages/mailroom/inbox',
		appBasePath: '/@jane/packages/mailroom',
	})
})
