import { expect, test } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import {
	createOAuthCallbackNavigationScope,
	oauthCallbackFlowKey,
} from './oauth-callback-navigation.ts'

async function fixture(callback: string) {
	const root = createRootRoute()
	const route = createRoute({
		getParentRoute: () => root,
		path: '/connect/oauth',
		validateSearch: (search: Record<string, unknown>) => search,
	})
	const other = createRoute({ getParentRoute: () => root, path: '/other' })
	const router = createRouter({
		// Exercise client history commits in Node. Server routers intentionally ignore navigate().
		isServer: false,
		origin: 'https://kody.test',
		routeTree: root.addChildren([route, other]),
		history: createMemoryHistory({ initialEntries: [callback] }),
	})
	await router.load()
	const scope = createOAuthCallbackNavigationScope(router.latestLocation)
	router.subscribe('onBeforeNavigate', ({ toLocation }) =>
		scope.navigate(toLocation),
	)
	return { router, scope }
}

for (const callback of [
	'code=private-code&state=private-state',
	'error=access_denied&error_description=private-error',
]) {
	test(`native replacement retains one callback flow and drops callback fields: ${callback.split('=')[0]}`, async () => {
		const { router, scope } = await fixture(`/connect/oauth?${callback}`)
		await router.invalidate()
		expect(scope.isActive()).toBe(true)
		const key = oauthCallbackFlowKey(router.latestLocation)!
		const cleanHref = '/connect/oauth?org=team'
		scope.replace(cleanHref, key)
		await router.navigate({
			href: cleanHref,
			replace: true,
			state: { oauthCallbackFlow: { key, href: cleanHref } },
		})
		expect(router.state.location.href).toBe(cleanHref)
		expect(router.history.location.href).toBe(cleanHref)
		expect(oauthCallbackFlowKey(router.latestLocation)).toBe(key)
		expect(scope.isActive()).toBe(true)
		expect(JSON.stringify(router.history.location)).not.toContain('private-')
		expect(router.history.length).toBe(1)
		await router.invalidate()
		expect(scope.isActive()).toBe(true)
		expect(oauthCallbackFlowKey(router.latestLocation)).toBe(key)
		await router.navigate({ href: '/other' })
		expect(scope.isActive()).toBe(false)
		await router.navigate({ href: cleanHref })
		expect(scope.isActive()).toBe(false)
		expect(oauthCallbackFlowKey(router.latestLocation)).not.toBe(key)
	})
}

test('unrelated navigation before cleanup completes invalidates the callback permanently', async () => {
	const { router, scope } = await fixture('/connect/oauth?code=secret')
	const key = oauthCallbackFlowKey(router.latestLocation)!
	scope.replace('/connect/oauth?org=team', key)
	await router.navigate({ href: '/connect/oauth?provider=another' })
	expect(scope.isActive()).toBe(false)
	await router.navigate({
		href: '/connect/oauth?org=team',
		replace: true,
		state: { oauthCallbackFlow: { key, href: '/connect/oauth?org=team' } },
	})
	expect(scope.isActive()).toBe(false)
})

test('setup refresh remains active but a new history entry at the same URL cancels it', async () => {
	const { router, scope } = await fixture('/connect/oauth?provider=example')
	await router.invalidate()
	expect(scope.isActive()).toBe(true)
	// History push explicitly creates a new visit even when its URL is identical.
	router.history.push('/connect/oauth?provider=example')
	await router.load()
	expect(scope.isActive()).toBe(false)
	await router.invalidate()
	expect(scope.isActive()).toBe(false)
})
