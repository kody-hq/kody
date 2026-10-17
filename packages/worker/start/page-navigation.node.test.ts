import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import {
	createRouter,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	RouterContextProvider,
	Match,
	Outlet,
	useRouteContext,
} from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { pageNavigationForMatches } from './page-navigation.ts'
const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
function resolve(path: string) {
	const [routes, params] = router.getMatchedRoutes(path)
	return pageNavigationForMatches(
		routes.map((route) => ({
			staticData: route.options.staticData ?? {},
			params,
		})),
	)
}
test.each([
	['/account', 'account', 'profile', null],
	['/@acme/-/credentials/key', 'workspace', 'credentials', 'acme'],
	['/@acme/-/secrets/user/key', 'workspace', 'credentials', 'acme'],
	[
		'/@acme/-/secret-providers/approve',
		'workspace',
		'secret-providers',
		'acme',
	],
	['/account/passkeys', 'account', 'security', null],
	['/account/two-factor', 'account', 'security', null],
	['/account/mcp-oauth-clients', 'workspace', 'agents', null],
	['/@acme/-/integrations/apps/google', 'workspace', 'credentials', 'acme'],
	['/@acme/-/mcp-servers/server/authorize', 'workspace', 'credentials', 'acme'],
	['/@acme/-/workflows/run', 'workspace', 'workflows', 'acme'],
	['/@acme/-/waiting', 'workspace', 'waiting', 'acme'],
	['/@acme/-/grants', 'workspace', 'grants', 'acme'],
	['/@acme/-/credits', 'workspace', 'credits', 'acme'],
	['/admin/users/person', 'admin', 'users', null],
	[
		'/admin/platform-integrations/google',
		'admin',
		'platform-integrations',
		null,
	],
] as const)(
	'native selection for %s owns rail, item, and workspace',
	(path, rail, item, orgSlug) => {
		expect(resolve(path)).toMatchObject({ rail, item, orgSlug })
	},
)
test('retained page reads its own route context while destination loader is pending', async () => {
	let release: () => void = () => {}
	let started: () => void = () => {}
	const waiting = new Promise<void>((resolve) => {
		release = resolve
	})
	const entered = new Promise<void>((resolve) => {
		started = resolve
	})
	const root = createRootRoute({
		beforeLoad: ({ matches }) => ({
			pageNavigation: pageNavigationForMatches(matches),
		}),
		component: () => createElement(Outlet),
	})
	function Page() {
		const context = useRouteContext({ strict: false })
		return createElement(
			'p',
			null,
			context.pageNavigation?.rail + ':' + context.pageNavigation?.item,
		)
	}
	const jobs = createRoute({
		getParentRoute: () => root,
		path: '/jobs',
		staticData: { navigation: { rail: 'workspace', item: 'jobs' } },
		component: Page,
	})
	const security = createRoute({
		getParentRoute: () => root,
		path: '/security',
		staticData: { navigation: { rail: 'account', item: 'security' } },
		loader: async () => {
			started()
			await waiting
			return null
		},
		component: Page,
	})
	const pendingRouter = createRouter({
		routeTree: root.addChildren([jobs, security]),
		history: createMemoryHistory({ initialEntries: ['/jobs'] }),
		origin: 'https://kody.test',
		isServer: false,
		defaultPendingMs: 60_000,
	})
	await pendingRouter.load()
	// Snapshot the real match tree without mounting the browser transition adapter.
	// Its layout-effect acknowledgment cannot run in renderToString.
	const render = () =>
		renderToString(
			createElement(RouterContextProvider, {
				router: pendingRouter,
				children: createElement(Match, { routeId: root.id }),
			}),
		)
	expect(render()).toContain('workspace:jobs')
	const navigation = pendingRouter.navigate({ to: '/security' })
	await entered
	expect(pendingRouter.latestLocation.pathname).toBe('/security')
	expect(render()).toContain('workspace:jobs')
	release()
	await navigation
	expect(render()).toContain('account:security')
})
test('profile identity stays distinct from an explicitly scoped workspace', () => {
	expect(resolve('/@acme')).toEqual({
		rail: 'workspace',
		item: 'overview',
		orgSlug: null,
		profileSlug: 'acme',
	})
	expect(resolve('/@acme/pkg/approve-publish')).toEqual({
		rail: 'workspace',
		item: 'packages',
		orgSlug: null,
		profileSlug: 'acme',
	})
	expect(resolve('/admin')).toEqual({
		rail: 'admin',
		item: 'users',
		orgSlug: null,
	})
	expect(resolve('/missing-page')).toBeUndefined()
})

test.each([
	['/@acme', undefined],
	['/@acme/-/secrets/user/token', { section: 'secrets', rest: 'user/token' }],
	['/@acme/-/credentials/token', { section: 'credentials', rest: 'token' }],
	[
		'/@acme/-/integrations/apps/google',
		{ section: 'integrations', rest: 'apps/google' },
	],
	[
		'/@acme/-/mcp-servers/server/authorize',
		{ section: 'mcp-servers', rest: 'server/authorize' },
	],
	['/@acme/-/secrets/new', { section: 'secrets', rest: 'new' }],
	['/@acme/-/billing/success', { section: 'billing', rest: undefined }],
	['/@acme/-/overview', undefined],
])(
	'native switch destination preserves the matched family and suffix: %s',
	(path, target) => {
		expect(resolve(path)?.workspaceSwitch).toEqual(target)
	},
)

test('switch suffix encodes matched identifiers as single path segments', () => {
	const navigation = pageNavigationForMatches([
		{
			staticData: {
				navigation: { rail: 'workspace', item: 'credentials' },
				workspaceSwitch: {
					section: 'secrets',
					suffix: ['user', { param: 'secretName' }],
				},
			},
			params: { orgSlug: 'acme', secretName: 'literal%2F/part' },
		},
	])
	expect(navigation?.workspaceSwitch).toEqual({
		section: 'secrets',
		rest: 'user/literal%252F%2Fpart',
	})
})
