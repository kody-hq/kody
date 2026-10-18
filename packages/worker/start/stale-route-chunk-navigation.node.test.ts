import { expect, test } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'

const chunkMiss = new TypeError(
	'Failed to fetch dynamically imported module: https://kody.codes/assets/pricing-CgSDztSN.js',
)

test('a failed lazy route chunk is imported after history already points at the target', async () => {
	const root = createRootRoute()
	let pathnameWhenChunkImportRan: string | undefined
	let readHistoryPathname = () => ''
	const index = createRoute({
		getParentRoute: () => root,
		path: '/',
	})
	const pricing = createRoute({
		getParentRoute: () => root,
		path: '/pricing',
	}).lazy(() => {
		pathnameWhenChunkImportRan = readHistoryPathname()
		return Promise.reject(chunkMiss)
	})
	const router = createRouter({
		routeTree: root.addChildren([index, pricing]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
		isServer: false,
		origin: 'https://kody.test',
	})
	readHistoryPathname = () => router.history.location.pathname
	await router.load()
	// RouterProvider's Transitioner subscribes before SPA navigations. Push
	// notifies that subscriber, which loads the lazy chunk. commitLocation
	// pushes before either path calls load.
	const stopHistory = router.history.subscribe(({ action }) => {
		void router.load({ action })
	})
	try {
		await router.navigate({ href: '/pricing' })
		expect(pathnameWhenChunkImportRan).toBe('/pricing')
		expect(router.history.location.pathname).toBe('/pricing')
		expect(router.state.location.pathname).toBe('/pricing')
		expect(
			router.state.matches.some(
				(match) => match.routeId === pricing.id && match.status === 'error',
			),
		).toBe(true)
	} finally {
		stopHistory()
	}
})
