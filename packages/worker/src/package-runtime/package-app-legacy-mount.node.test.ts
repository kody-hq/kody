import { expect, test, vi } from 'vitest'
import {
	buildLegacyPackageAppSubdomainMountLocation,
	maybeHandleLegacyPackageAppSubdomainMount,
	packageAppLegacyMountEventKind,
	shouldRedirectLegacyPackageAppSubdomainMount,
} from './package-app-legacy-mount.ts'

test('shouldRedirectLegacyPackageAppSubdomainMount matches browser HTML GET/HEAD only', () => {
	expect(
		shouldRedirectLegacyPackageAppSubdomainMount(
			new Request('https://alice.kody.run/packages/demo', {
				headers: { Accept: 'text/html' },
			}),
		),
	).toBe(true)
	expect(
		shouldRedirectLegacyPackageAppSubdomainMount(
			new Request('https://alice.kody.run/packages/demo', {
				method: 'HEAD',
				headers: { Accept: 'text/html' },
			}),
		),
	).toBe(true)
	expect(
		shouldRedirectLegacyPackageAppSubdomainMount(
			new Request('https://alice.kody.run/packages/demo', {
				method: 'POST',
				headers: { Accept: 'text/html' },
			}),
		),
	).toBe(false)
	expect(
		shouldRedirectLegacyPackageAppSubdomainMount(
			new Request('https://alice.kody.run/packages/demo', {
				headers: { Accept: 'application/json' },
			}),
		),
	).toBe(false)
	expect(
		shouldRedirectLegacyPackageAppSubdomainMount(
			new Request('https://alice.kody.run/packages/demo', {
				headers: { Accept: 'text/html;q=0, application/json' },
			}),
		),
	).toBe(false)
})

test('buildLegacyPackageAppSubdomainMountLocation preserves rest and query', () => {
	expect(
		buildLegacyPackageAppSubdomainMountLocation({
			url: new URL('https://alice.kody.run/packages/demo/report?tab=1'),
			packagePath: { kodyId: 'demo', restPath: '/report' },
		}),
	).toBe('/demo/report?tab=1')
	expect(
		buildLegacyPackageAppSubdomainMountLocation({
			url: new URL('https://alice.kody.run/packages/demo'),
			packagePath: { kodyId: 'demo', restPath: '/' },
		}),
	).toBe('/demo')
})

test('maybeHandleLegacyPackageAppSubdomainMount redirects HTML and rewrites others', () => {
	const writeDataPoint = vi.fn()
	const env = { PACKAGE_APP_LEGACY_EVENTS: { writeDataPoint } }
	const packagePath = {
		username: 'alice',
		kodyId: 'demo',
		restPath: '/report',
		mount: 'user-subdomain' as const,
	}

	const redirected = maybeHandleLegacyPackageAppSubdomainMount({
		request: new Request('https://alice.kody.run/packages/demo/report?x=1', {
			headers: { Accept: 'text/html' },
		}),
		env,
		url: new URL('https://alice.kody.run/packages/demo/report?x=1'),
		packagePath,
	})
	expect(redirected?.status).toBe(308)
	expect(redirected?.headers.get('Vary')).toBe('Accept')
	expect(redirected?.headers.get('Cache-Control')).toBe('public, max-age=300')
	expect(redirected?.headers.get('Location')).toBe('/demo/report?x=1')
	expect(writeDataPoint).toHaveBeenCalledWith({
		indexes: ['alice'],
		blobs: [packageAppLegacyMountEventKind, 'alice', 'demo', 'GET', 'redirect'],
		doubles: [1],
	})

	writeDataPoint.mockClear()
	const handoffRedirect = maybeHandleLegacyPackageAppSubdomainMount({
		request: new Request(
			'https://alice.kody.run/packages/demo?__kody_handoff=token',
			{ headers: { Accept: 'text/html' } },
		),
		env,
		url: new URL('https://alice.kody.run/packages/demo?__kody_handoff=token'),
		packagePath: { ...packagePath, restPath: '/' },
	})
	expect(handoffRedirect?.headers.get('Cache-Control')).toBe(
		'private, no-store',
	)
	expect(handoffRedirect?.headers.get('Location')).toBe(
		'/demo?__kody_handoff=token',
	)

	writeDataPoint.mockClear()
	const rewritten = maybeHandleLegacyPackageAppSubdomainMount({
		request: new Request('https://alice.kody.run/packages/demo/report', {
			headers: { Accept: 'application/json' },
		}),
		env,
		url: new URL('https://alice.kody.run/packages/demo/report'),
		packagePath,
	})
	expect(rewritten).toBeNull()
	expect(writeDataPoint).toHaveBeenCalledWith({
		indexes: ['alice'],
		blobs: [packageAppLegacyMountEventKind, 'alice', 'demo', 'GET', 'rewrite'],
		doubles: [1],
	})

	expect(
		maybeHandleLegacyPackageAppSubdomainMount({
			request: new Request('https://alice.kody.run/demo', {
				headers: { Accept: 'text/html' },
			}),
			env,
			url: new URL('https://alice.kody.run/demo'),
			packagePath: { ...packagePath, restPath: '/' },
		}),
	).toBeNull()
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
})
