import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import {
	createMemoryHistory,
	createRouter,
	createRootRoute,
	createRoute,
} from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import {
	isServerFunctionRequest,
	rejectActionPageHead,
} from './action-page-method.ts'
import {
	verifyEmailDestinationHead,
	unsubscribeTipsPost,
} from '#start/server/action-page-http'
// Coverage inventory only. Production preload policy belongs to each native route.
const actionPagePaths = [
	'/account/billing/success',
	'/verify-email',
	'/verify-email-change',
	'/verify-email-claim-release',
	'/verify-email-destination',
	'/unsubscribe/tips',
	'/@example/-/billing/success',
]

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})

test('native HEAD handlers prevent token and billing document loaders from running', async () => {
	for (const pathname of actionPagePaths) {
		const [, , route] = router.getMatchedRoutes(pathname)
		assert.ok(route)
		assert.equal(route.options.preload, false)
		const handlers = route.options.server?.handlers
		assert.ok(handlers && typeof handlers === 'object')
		if (pathname === '/verify-email-destination') {
			assert.equal(handlers.HEAD, verifyEmailDestinationHead)
			continue
		}
		assert.equal(handlers.HEAD, rejectActionPageHead)
		// This handler returns a response directly, without calling next or a loader.
		const response = await rejectActionPageHead()
		assert.equal(response.status, 405)
		assert.equal(response.headers.get('Allow'), 'GET')
		assert.equal(await response.text(), '')
		assert.equal(handlers.GET, undefined)
	}
})

test('native RPC detection does not depend on the token-page URL inventory', () => {
	vi.stubEnv('TSS_SERVER_FN_BASE', '/_serverFn/')
	try {
		assert.equal(
			isServerFunctionRequest(
				new Request('https://kody.test/_serverFn/example', { method: 'POST' }),
			),
			true,
		)
		assert.equal(
			isServerFunctionRequest(new Request('https://kody.test/verify-email')),
			false,
		)
	} finally {
		vi.unstubAllEnvs()
	}
})

test('mail-provider one-click unsubscribe has an explicit native POST handler', () => {
	const [, , route] = router.getMatchedRoutes('/unsubscribe/tips')
	const handlers = route?.options.server?.handlers
	assert.ok(handlers && typeof handlers === 'object')
	assert.equal(handlers.POST, unsubscribeTipsPost)
})

test('native action route policy blocks explicit preloads but permits a real navigation', async () => {
	for (const pathname of [...actionPagePaths, '/oauth/authorize']) {
		const [, , nativeRoute] = router.getMatchedRoutes(pathname)
		assert.ok(nativeRoute)
		const loader = vi.fn(() => 'consumed')
		const root = createRootRoute()
		const action = createRoute({
			getParentRoute: () => root,
			path: '/action',
			preload: nativeRoute.options.preload,
			loader,
		})
		const isolatedRouter = createRouter({
			routeTree: root.addChildren([action]),
			history: createMemoryHistory({ initialEntries: ['/'] }),
			isServer: false,
			origin: 'https://kody.test',
		})
		await isolatedRouter.preloadRoute({ to: '/action' } as never)
		assert.equal(
			loader.mock.calls.length,
			0,
			`${pathname} must not consume on preload`,
		)
		await isolatedRouter.navigate({ to: '/action' } as never)
		assert.equal(
			loader.mock.calls.length,
			1,
			`${pathname} must load on navigation`,
		)
	}
})
