import { expect, test } from 'vitest'
import { parsePackageAppPath } from '#worker/package-runtime/package-app-serve.ts'
import { isNamespacedAppEndpointPath } from './user-namespace-routes.ts'

test('machine namespaces claim only their multi-segment paths', () => {
	expect(isNamespacedAppEndpointPath('/@kody/packages/devin')).toBe(true)
	expect(isNamespacedAppEndpointPath('/@kody/packages/devin/index.html')).toBe(
		true,
	)
	expect(isNamespacedAppEndpointPath('/@kody/connectors/home')).toBe(true)
	expect(isNamespacedAppEndpointPath('/@kody/webhooks/devin/hook/secret')).toBe(
		true,
	)
	expect(isNamespacedAppEndpointPath('/community/listing-1')).toBe(false)

	// Including the ids that spell a namespace segment: the two-segment form is
	// the public page, not a truncated machine path. Org pages under `/-/` are
	// also not machine surfaces.
	for (const pathname of [
		'/@kody/devin',
		'/@kody/packages',
		'/@kody/connectors',
		'/@kody/webhooks',
		'/@kody/api',
		'/@kody/-/repositories',
		'/@kody/-/webhooks',
		'/@kody/-/billing',
	]) {
		expect(isNamespacedAppEndpointPath(pathname)).toBe(false)
		expect(parsePackageAppPath(pathname)).toBeNull()
	}

	expect(parsePackageAppPath('/@kody/packages/devin')).toEqual({
		username: 'kody',
		kodyId: 'devin',
		restPath: '/',
		mount: 'username-path',
	})
	expect(parsePackageAppPath('/@kody/packages/devin/open')).toEqual({
		username: 'kody',
		kodyId: 'devin',
		restPath: '/',
		mount: 'username-path',
		openHandoff: true,
	})
	expect(parsePackageAppPath('/@kody/packages/devin/open/report')).toEqual({
		username: 'kody',
		kodyId: 'devin',
		restPath: '/report',
		mount: 'username-path',
		openHandoff: true,
	})
	expect(parsePackageAppPath('/@kody/devin')).toBeNull()
	expect(
		isNamespacedAppEndpointPath('/@kody/doom/assets/docs/poster.png'),
	).toBe(false)
	expect(parsePackageAppPath('/@kody/doom/assets/docs/poster.png')).toBeNull()
})
