import { expect, test } from 'vitest'
import {
	getAppBaseUrl,
	getCanonicalAppBaseUrl,
	getPackageAppBaseUrl,
	getPackageAppLegacySubdomainRedirect,
	getPackageAppOriginConfigurationError,
	hostnameSharesKodyRegistrableDomain,
	isKodyReservedCustomHostname,
	listKodyRegistrableDomains,
	joinAppUrl,
	parsePackageAppRequestHost,
} from './app-base-url.ts'

type BaseUrlEnv = Parameters<typeof getAppBaseUrl>[0]['env']

test('app base URLs prefer the request origin, fall back to APP_BASE_URL then kody.codes, and joinAppUrl strips trailing slashes', () => {
	const packageAppEnv = {
		APP_BASE_URL: 'https://heykody.dev',
		PACKAGE_APP_BASE_URL: 'https://kodyapps.dev',
	}
	const appBaseUrlCases: Array<
		[env: BaseUrlEnv, requestUrl: string | null | undefined, expected: string]
	> = [
		[
			{ APP_BASE_URL: 'https://heykody.dev' },
			'https://kody-production.kody-a99.workers.dev/mcp',
			'https://kody-production.kody-a99.workers.dev',
		],
		[
			{ APP_BASE_URL: 'https://configured.example' },
			'https://heykody.dev/mcp',
			'https://heykody.dev',
		],
		[
			{ APP_BASE_URL: 'https://configured.example/path' },
			undefined,
			'https://configured.example',
		],
		[{ APP_BASE_URL: '' }, undefined, 'https://kody.codes'],
		[{}, null, 'https://kody.codes'],
		// Package runtime callbacks and first-party links resolved while serving a
		// package app must point at the app origin, never at the package-app host —
		// neither the bare origin nor a per-user subdomain.
		[
			packageAppEnv,
			'https://kodyapps.dev/@me/packages/x',
			'https://heykody.dev',
		],
		[
			packageAppEnv,
			'https://user-me.kodyapps.dev/packages/x',
			'https://heykody.dev',
		],
		[
			packageAppEnv,
			'https://heykody.dev/@me/packages/x',
			'https://heykody.dev',
		],
	]
	expect(
		appBaseUrlCases.filter(
			([env, requestUrl, expected]) =>
				getAppBaseUrl({ env, requestUrl }) !== expected,
		),
	).toEqual([])

	expect(
		joinAppUrl({
			env: { APP_BASE_URL: 'https://heykody.dev/' },
			path: '/admin/insights',
		}),
	).toBe('https://heykody.dev/admin/insights')
	expect(
		joinAppUrl({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			path: 'admin/users',
		}),
	).toBe('https://heykody.dev/admin/users')

	// A page dual-served from a legacy host must emit canonical URLs on the
	// configured canonical origin, not the host it happened to be served from.
	expect(
		getCanonicalAppBaseUrl({
			env: { APP_BASE_URL: 'https://heykody.app' },
			requestUrl: 'https://heykody.dev/blog',
		}),
	).toBe('https://heykody.app')
	// Local dev and preview leave APP_BASE_URL unset; the request origin is
	// the only origin those deployments can serve.
	expect(
		getCanonicalAppBaseUrl({
			env: {},
			requestUrl: 'http://localhost:3742/blog',
		}),
	).toBe('http://localhost:3742')
	expect(getCanonicalAppBaseUrl({ env: {} })).toBe('https://kody.codes')
})

test('the package-app origin is configurable and ignored by local dev unless it is servable', () => {
	const packageAppCases: Array<
		[
			packageAppBaseUrl: string | undefined,
			localDevFlag: string | undefined,
			expected: string | null,
		]
	> = [
		[undefined, undefined, null],
		['  ', undefined, null],
		['not-a-url', undefined, null],
		['https://kodyapps.dev/ignored', undefined, 'https://kodyapps.dev'],
		// `npm run dev` runs the production Wrangler env, so local dev sees the
		// committed production value and must ignore an origin it cannot serve.
		['https://kodyapps.dev', 'true', null],
		[
			'http://packages.localhost:3742',
			'true',
			'http://packages.localhost:3742',
		],
		// Only the literal 'true' means local dev, so a stray value cannot pull
		// package apps back onto the app origin in a real deployment.
		...['false', '0', 'no', ' '].map(
			(flag) =>
				['https://kodyapps.dev', flag, 'https://kodyapps.dev'] as [
					string,
					string,
					string,
				],
		),
	]
	expect(
		packageAppCases.filter(
			([PACKAGE_APP_BASE_URL, WRANGLER_IS_LOCAL_DEV, expected]) =>
				getPackageAppBaseUrl({
					env: { PACKAGE_APP_BASE_URL, WRANGLER_IS_LOCAL_DEV },
				}) !== expected,
		),
	).toEqual([])
})

test('parsePackageAppRequestHost classifies apex, user subdomains, and rejects everything else', () => {
	const env = { PACKAGE_APP_BASE_URL: 'https://kodyapps.dev' }
	const legacyEnv = {
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		PACKAGE_APP_LEGACY_HOSTS: 'kodyapps.dev',
	}
	const unrecognized = { kind: 'unrecognized-subdomain', role: 'canonical' }
	const cases: Array<[env: typeof env | typeof legacyEnv, string, unknown]> = [
		[env, 'https://kodyapps.dev/anything', { kind: 'apex', role: 'canonical' }],
		[
			env,
			'https://kentcdodds.kodyapps.dev/packages/demo',
			{ kind: 'user-subdomain', username: 'kentcdodds', role: 'canonical' },
		],
		// Hostnames the wildcard route still delivers, but that no user can own:
		// nested labels, invalid username labels, and the wrong scheme.
		[env, 'https://a.b.kodyapps.dev/', unrecognized],
		[env, 'https://xy.kodyapps.dev/', unrecognized],
		[env, 'https://bad_label.kodyapps.dev/', unrecognized],
		[env, 'http://kentcdodds.kodyapps.dev/', unrecognized],
		// Trailing DNS dots resolve to the same host but survive in
		// URL.hostname; letting them fall through would route them first-party.
		[env, 'https://kodyapps.dev./', unrecognized],
		[env, 'https://kentcdodds.kodyapps.dev./', unrecognized],
		// Not the package-app domain at all. Same hostname on another
		// scheme/port is another local service.
		[env, 'https://heykody.dev/', null],
		[env, 'https://evil-kodyapps.dev/', null],
		[env, 'https://kodyapps.dev.attacker.example/', null],
		[env, 'http://kodyapps.dev/', null],
		[
			legacyEnv,
			'https://alice.kody.run/packages/demo',
			{ kind: 'user-subdomain', username: 'alice', role: 'canonical' },
		],
		[
			legacyEnv,
			'https://alice.kodyapps.dev/packages/demo',
			{ kind: 'user-subdomain', username: 'alice', role: 'legacy' },
		],
		[legacyEnv, 'https://kodyapps.dev/', { kind: 'apex', role: 'legacy' }],
		[legacyEnv, 'https://kody.run/', { kind: 'apex', role: 'canonical' }],
		[legacyEnv, 'https://kody.codes/', null],
	]
	expect(
		cases.map(([caseEnv, url]) => [
			url,
			parsePackageAppRequestHost({ env: caseEnv, url: new URL(url) }),
		]),
	).toEqual(cases.map(([, url, expected]) => [url, expected]))
	// No configured package-app origin: nothing classifies.
	expect(
		parsePackageAppRequestHost({
			env: {},
			url: new URL('https://kentcdodds.kodyapps.dev/'),
		}),
	).toBeNull()
})

test('production package-app origin configuration requires a separate registrable domain', () => {
	const production = (
		appBaseUrl: string,
		packageAppBaseUrl?: string,
		legacyHosts?: string,
	) => ({
		APP_BASE_URL: appBaseUrl,
		PACKAGE_APP_BASE_URL: packageAppBaseUrl,
		PACKAGE_APP_LEGACY_HOSTS: legacyHosts,
		SENTRY_ENVIRONMENT: 'production',
	})
	const cases: Array<
		[env: Parameters<typeof getPackageAppOriginConfigurationError>[0], boolean]
	> = [
		[
			{ APP_BASE_URL: 'https://heykody.dev', SENTRY_ENVIRONMENT: 'preview' },
			false,
		],
		[production('https://heykody.dev'), true],
		[production('https://heykody.dev', 'https://heykody.dev'), true],
		[production('https://heykody.dev', 'https://apps.heykody.dev'), true],
		[production('https://heykody.dev', 'https://kodyapps.dev'), false],
		[production('https://kody.codes', 'https://kody.run'), false],
		[
			production('https://kody.codes', 'https://kody.run', 'kodyapps.dev'),
			false,
		],
		[
			production('https://kody.codes', 'https://kody.run', 'apps.kody.codes'),
			true,
		],
	]
	expect(
		cases.filter(
			([env, isError]) =>
				(getPackageAppOriginConfigurationError(env) !== null) !== isError,
		),
	).toEqual([])
})

test('legacy package-app subdomain redirect is opt-in GET/HEAD only', () => {
	const env = {
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		PACKAGE_APP_LEGACY_HOSTS: 'kodyapps.dev',
		PACKAGE_APP_LEGACY_REDIRECT: 'true',
	}
	const redirectFor = (
		url: string,
		init?: RequestInit,
		redirectEnv: typeof env = env,
	) => {
		const requestHost = parsePackageAppRequestHost({ env, url: new URL(url) })
		if (!requestHost) throw new Error(`Expected a package-app host for ${url}`)
		return getPackageAppLegacySubdomainRedirect({
			request: new Request(url, init),
			env: redirectEnv,
			requestHost,
		})
	}

	const response = redirectFor('https://alice.kodyapps.dev/packages/demo?tab=1')
	expect(response?.status).toBe(308)
	expect(response?.headers.get('location')).toBe(
		'https://alice.kody.run/packages/demo?tab=1',
	)

	expect(
		redirectFor('https://alice.kodyapps.dev/packages/demo', { method: 'POST' }),
	).toBeNull()
	expect(redirectFor('https://kodyapps.dev/')).toBeNull()
	expect(redirectFor('https://alice.kody.run/packages/demo')).toBeNull()
	expect(
		redirectFor('https://alice.kodyapps.dev/packages/demo', undefined, {
			...env,
			PACKAGE_APP_LEGACY_REDIRECT: 'false',
		}),
	).toBeNull()
})

test('custom hostnames must not share a registrable domain with Kody origins', () => {
	const env = {
		APP_BASE_URL: 'https://kody.codes',
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		APP_LEGACY_HOSTS: 'heykody.dev',
	}
	expect(
		hostnameSharesKodyRegistrableDomain({
			env,
			hostname: 'evil.kody.codes',
		}),
	).toBe(true)
	expect(
		hostnameSharesKodyRegistrableDomain({
			env,
			hostname: 'apps.kody.run',
		}),
	).toBe(true)
	expect(
		hostnameSharesKodyRegistrableDomain({
			env,
			hostname: 'legacy.heykody.dev',
		}),
	).toBe(true)
	expect(
		hostnameSharesKodyRegistrableDomain({
			env,
			hostname: 'app.customer-test.example',
		}),
	).toBe(false)
})

test('reserved custom hostnames come from the same Kody domain list', () => {
	const env = {
		APP_BASE_URL: 'https://kody.codes',
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		APP_LEGACY_HOSTS: 'legacy-kody.example',
		PACKAGE_APP_LEGACY_HOSTS: 'www.kody.run',
	}
	expect(listKodyRegistrableDomains(env)).toEqual([
		'kody.codes',
		'kody.run',
		'legacy-kody.example',
	])
	for (const hostname of [
		'kody.codes',
		'docs.kody.codes.',
		'apps.kody.run',
		'a.b.legacy-kody.example',
		'demo.workers.dev',
	]) {
		expect(isKodyReservedCustomHostname({ env, hostname })).toBe(true)
	}
	expect(
		isKodyReservedCustomHostname({ env, hostname: 'apps.example.com' }),
	).toBe(false)
	expect(
		isKodyReservedCustomHostname({ env, hostname: 'kody.codes.example.com' }),
	).toBe(false)
})
