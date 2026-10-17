import { afterEach, expect, test, vi } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import { consumeAccountCreatedFathomSignal } from '#client/fathom-events.ts'

afterEach(() => vi.unstubAllGlobals())

test('account-created cleanup updates native Router location without losing entry state', async () => {
	const root = createRootRoute()
	const route = createRoute({
		getParentRoute: () => root,
		path: '/onboarding',
		validateSearch: (search: Record<string, unknown>) => search,
	})
	const router = createRouter({
		routeTree: root.addChildren([route]),
		history: createMemoryHistory({
			initialEntries: ['/onboarding?accountCreated=1&other=value#step'],
		}),
	})
	await router.load()
	const trackEvent = vi.fn()
	vi.stubGlobal('window', {
		get location() {
			return { href: `https://kody.codes${router.history.location.href}` }
		},
		fathom: { trackEvent },
	})
	const index = router.history.location.state.__TSR_index
	expect(
		consumeAccountCreatedFathomSignal((href) =>
			router.history.replace(href, router.history.location.state),
		),
	).toBe(true)
	await router.load()
	expect(router.state.location.href).toBe('/onboarding?other=value#step')
	expect(router.history.location.state.__TSR_index).toBe(index)
	expect(router.history.length).toBe(1)
	expect(trackEvent).toHaveBeenCalledExactlyOnceWith('account_created')
})
