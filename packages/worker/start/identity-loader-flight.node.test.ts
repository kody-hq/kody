import { expect, test } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'

test('blocking root loader sharing does not imply a fresh authority check per navigation', async () => {
	let actor = 'a'
	let hold = false
	let release!: () => void
	const barrier = new Promise<void>((resolve) => {
		release = resolve
	})
	let captured!: () => void
	const started = new Promise<void>((resolve) => {
		captured = resolve
	})
	const reads: string[] = []
	const root = createRootRoute({
		shouldReload: true,
		loader: {
			staleReloadMode: 'blocking',
			handler: async () => {
				const snapshot = actor
				reads.push(snapshot)
				if (hold) {
					captured()
					await barrier
				}
				return { actor: snapshot }
			},
		},
	})
	const router = createRouter({
		routeTree: root.addChildren(
			['/', '/one', '/two'].map((path) =>
				createRoute({ getParentRoute: () => root, path }),
			),
		),
		history: createMemoryHistory({ initialEntries: ['/'] }),
		isServer: false,
		origin: 'https://identity.test',
	})
	await router.load()
	hold = true
	const first = router.navigate({ href: '/one' })
	await started
	actor = 'b'
	const second = router.navigate({ href: '/two' })
	await new Promise((resolve) => setTimeout(resolve, 0))
	release()
	await Promise.all([first, second])
	expect(router.state.location.pathname).toBe('/two')
	expect(reads).toEqual(['a', 'a'])
	expect(router.state.matches[0]?.loaderData).toEqual({ actor: 'a' })
})

test('root beforeLoad verifies once per foreground navigation and skips intent preloads', async () => {
	const checks: string[] = []
	const root = createRootRoute({
		preload: false,
		shouldReload: true,
		beforeLoad: async ({ location, preload }) => {
			if (!preload) checks.push(location.pathname)
			return { actor: 'a' }
		},
		loader: { staleReloadMode: 'blocking', handler: async () => ({}) },
	})
	const router = createRouter({
		routeTree: root.addChildren(
			['/one', '/two', '/three'].map((path) =>
				createRoute({
					getParentRoute: () => root,
					path,
					loader: async () => ({}),
				}),
			),
		),
		history: createMemoryHistory({ initialEntries: ['/one'] }),
		isServer: false,
		origin: 'https://identity.test',
		defaultPreloadStaleTime: 0,
		defaultStaleReloadMode: 'blocking',
	})
	await router.load()
	await Promise.all(
		Array.from({ length: 12 }, () => router.preloadRoute({ to: '/two' })),
	)
	await router.navigate({ href: '/two' })
	await router.preloadRoute({ to: '/three' })
	await router.navigate({ href: '/three' })
	expect(checks).toEqual(['/one', '/two', '/three'])
})
