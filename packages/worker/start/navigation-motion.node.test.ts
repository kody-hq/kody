import { expect, test } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	redirect,
	type AnyRoute,
} from '@tanstack/react-router'
import {
	installNavigationMotion,
	navigationMotionGroup,
	shouldUseViewTransition,
} from './navigation-motion.ts'
import { routeTree } from './routeTree.gen.ts'
import { QueryClient } from '@tanstack/react-query'

function fixture() {
	const root = createRootRoute()
	let releaseSlow!: () => void
	const slow = new Promise<void>((resolve) => {
		releaseSlow = resolve
	})
	const children: AnyRoute[] = [
		'/',
		'/pricing',
		'/docs/one',
		'/docs/two',
		'/account',
		'/account/jobs',
	].map((path) =>
		createRoute({
			getParentRoute: () => root,
			path,
			staticData: {
				motionGroup: path.startsWith('/docs')
					? 'docs'
					: path.startsWith('/account')
						? 'account'
						: undefined,
			},
		}),
	)
	children.push(
		createRoute({
			getParentRoute: () => root,
			path: '/slow',
			loader: () => slow,
		}),
	)
	children.push(
		createRoute({
			getParentRoute: () => root,
			path: '/redirect',
			loader: () => {
				throw redirect({ href: '/docs/one' })
			},
		}),
	)
	const router = createRouter({
		routeTree: root.addChildren(children),
		history: createMemoryHistory({ initialEntries: ['/'] }),
		isServer: false,
		origin: 'https://motion.test',
	})
	let reduced = false
	let supported = true
	let marked = 0
	const stop = installNavigationMotion(router, {
		canStart: () => supported,
		prefersReducedMotion: () => reduced,
		hasPersistentShell: () => false,
		markSpaNavigation: () => {
			marked++
		},
	})
	// Mirror Router's mounted history subscription. A history observer alone
	// disables the router's no-subscriber fallback used by headless fixtures.
	const stopHistory = router.history.subscribe(({ action }) => {
		void router.load({ action })
	})
	return {
		router,
		stop: () => {
			stop()
			stopHistory()
		},
		releaseSlow,
		marked: () => marked,
		reduce: () => {
			reduced = true
		},
		unsupported: () => {
			supported = false
		},
	}
}

test('foreground motion policy covers initial load, pages, shell tabs, reduced motion and unsupported browsers', async () => {
	const f = fixture()
	await f.router.load()
	expect(f.marked()).toBe(0)
	expect(f.router.options.defaultViewTransition).toBe(false)
	await f.router.navigate({ href: '/pricing' })
	expect(f.router.options.defaultViewTransition).toBe(true)
	expect(f.marked()).toBe(1)
	await f.router.navigate({ href: '/docs/one' })
	await f.router.navigate({ href: '/docs/two' })
	expect(f.router.options.defaultViewTransition).toBe(false)
	const marks = f.marked()
	await f.router.invalidate()
	expect(f.marked()).toBe(marks)
	f.reduce()
	await f.router.navigate({ href: '/pricing' })
	expect(f.router.options.defaultViewTransition).toBe(false)
	f.unsupported()
	await f.router.navigate({ href: '/' })
	expect(f.router.options.defaultViewTransition).toBe(false)
	f.stop()
})

test('history and redirects recompute policy and mark committed client navigation', async () => {
	const f = fixture()
	await f.router.load()
	await f.router.navigate({ href: '/docs/one' })
	await f.router.navigate({ href: '/docs/two' })
	f.router.history.back()
	await f.router.load()
	expect(f.router.state.location.pathname).toBe('/docs/one')
	expect(f.router.options.defaultViewTransition).toBe(false)
	await f.router.navigate({ href: '/pricing' })
	await f.router.navigate({ href: '/redirect' })
	expect(f.router.state.location.pathname).toBe('/docs/one')
	expect(f.router.options.defaultViewTransition).toBe(true)
	expect(f.marked()).toBeGreaterThan(0)
	f.stop()
})

test('superseded slow navigation never mounts or marks its stale destination', async () => {
	const f = fixture()
	await f.router.load()
	const navigation = f.router.navigate({ href: '/slow' })
	await f.router.navigate({ href: '/docs/one' })
	const marks = f.marked()
	f.releaseSlow()
	await navigation
	expect(f.router.state.location.pathname).toBe('/docs/one')
	expect(f.marked()).toBe(marks)
	expect(f.router.options.defaultViewTransition).toBe(true)
	f.stop()
})

test('history traversal never starts a view transition', async () => {
	const f = fixture()
	await f.router.load()
	await f.router.navigate({ href: '/pricing' })
	expect(f.router.options.defaultViewTransition).toBe(true)
	f.router.history.back()
	await f.router.load()
	expect(f.router.options.defaultViewTransition).toBe(false)
	f.router.history.forward()
	await f.router.load()
	expect(f.router.options.defaultViewTransition).toBe(false)
	await f.router.navigate({ href: '/docs/one' })
	expect(f.router.options.defaultViewTransition).toBe(true)
	f.stop()
})

test('native chrome metadata preserves shell wizard profile and package transition exclusions', () => {
	const router = createRouter({
		origin: 'https://motion.test',
		routeTree,
		history: createMemoryHistory(),
		context: { queryClient: new QueryClient(), getCommittedPage: () => null },
	})
	const transition = (from: string, to: string) =>
		shouldUseViewTransition({
			from,
			to,
			fromGroup: navigationMotionGroup(
				router,
				new URL(from, 'https://kody.test').pathname,
			),
			toGroup: navigationMotionGroup(
				router,
				new URL(to, 'https://kody.test').pathname,
			),
			canStart: true,
			prefersReducedMotion: false,
		})
	for (const [from, to] of [
		['/account', '/account/security'],
		['/account/jobs', '/account/packages/pkg/files/src'],
		['/admin/users', '/admin/platform-integrations/new'],
		['/docs', '/docs/secrets'],
		['/onboarding/step-1/cursor', '/onboarding/step-3/claude-code'],
		['/@alice?sort=popular', '/@alice?sort=newest'],
		['/@acme/-/repositories?sort=popular', '/@acme/-/repositories?sort=newest'],
		['/@alice/tool', '/@alice/tool/tree/main/src/index.ts'],
		['/@alice/tool/files/src/index.ts', '/@alice/tool/settings'],
		['/@ALICE/TOOL/credentials', '/@alice/tool/mappings'],
		['/@alice/%74ool', '/@alice/tool/settings'],
		['/@alice/tool/triggers', '/@alice/tool/collaborators'],
	] as const)
		expect(transition(from, to)).toBe(false)
	for (const [from, to] of [
		['/account', '/admin/users'],
		['/docs', '/pricing'],
		['/account/security', '/account/not-a-real-page'],
		['/@alice', '/@bob'],
		['/@alice/tool', '/@alice/other'],
		['/@alice/tool', '/@alice/tool/approve-capabilities'],
		['/@alice/-/credentials', '/@alice/-/settings'],
		['/community/listing', '/community/listing/files/src'],
	] as const)
		expect(transition(from, to)).toBe(true)
})
