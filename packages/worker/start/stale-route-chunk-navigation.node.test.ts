import { expect, test, vi } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import {
	reloadOnStaleRouteChunk,
	setStaleRouteChunkReloadArmed,
	staleRouteChunkReloadFlag,
} from '#client/reload-on-stale-route-chunk.ts'

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

test('a route load arms stale-chunk reload and settling disarms it', async () => {
	const root = createRootRoute()
	let reloadedDuringImport = false
	const index = createRoute({
		getParentRoute: () => root,
		path: '/',
	})
	const pricing = createRoute({
		getParentRoute: () => root,
		path: '/pricing',
	}).lazy(() => {
		// The router retries the chunk after the first rejection. The first
		// call reloads; the retry must see the one-shot flag and refuse.
		reloadedDuringImport =
			reloadOnStaleRouteChunk(chunkMiss) || reloadedDuringImport
		return Promise.reject(chunkMiss)
	})
	const router = createRouter({
		routeTree: root.addChildren([index, pricing]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
		isServer: false,
		origin: 'https://kody.test',
	})
	const store = new Map<string, string>()
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => {
			store.set(key, value)
		},
		removeItem: (key: string) => {
			store.delete(key)
		},
	})
	vi.stubGlobal('window', { location: { reload: vi.fn() } })
	setStaleRouteChunkReloadArmed(false)
	expect(reloadOnStaleRouteChunk(chunkMiss)).toBe(false)

	router.subscribe('onBeforeLoad', () => {
		setStaleRouteChunkReloadArmed(true)
	})
	router.subscribe('onResolved', () => {
		setStaleRouteChunkReloadArmed(false)
	})
	await router.load()
	const stopHistory = router.history.subscribe(({ action }) => {
		void router.load({ action })
	})
	try {
		await router.navigate({ href: '/pricing' })
		expect(reloadedDuringImport).toBe(true)
		expect(store.get(staleRouteChunkReloadFlag)).toBe('1')
		store.delete(staleRouteChunkReloadFlag)
		expect(reloadOnStaleRouteChunk(chunkMiss)).toBe(false)
	} finally {
		stopHistory()
		setStaleRouteChunkReloadArmed(false)
		vi.unstubAllGlobals()
	}
})
