import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { routeTree } from './routeTree.gen.ts'
import { workspaceLayoutNavigation } from './workspace-layout-policy.ts'

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
const session = {
	username: 'jane',
	organizations: [
		{
			slug: 'jane',
			displayName: 'Jane',
			role: 'owner' as const,
			personal: true,
		},
		{
			slug: 'acme',
			displayName: 'Acme',
			role: 'member' as const,
			personal: false,
		},
	],
}
function matches(path: string) {
	const [routes, params] = router.getMatchedRoutes(path)
	return routes.map((route) => ({
		staticData: route.options.staticData ?? {},
		params,
	}))
}

test.each([
	['/account', 'account', 'profile'],
	['/@jane/-/overview', 'workspace', 'overview'],
	['/@acme/-/repositories', 'workspace', 'repositories'],
	['/@acme', 'workspace', 'public-profile'],
	['/@jane', 'workspace', 'public-profile'],
	['/@jane/example', 'workspace', 'repositories'],
	['/@acme/example', 'workspace', 'repositories'],
	['/admin/users', 'admin', 'users'],
	['/admin/orgs', 'admin', 'orgs'],
] as const)(
	'existing URL %s uses the shared workspace route',
	(path, rail, item) => {
		const [routes] = router.getMatchedRoutes(path)
		expect(routes.some((route) => route.id === '/_app')).toBe(true)
		expect(workspaceLayoutNavigation(matches(path), session)).toMatchObject({
			rail,
			item,
		})
	},
)

test.each([
	'/',
	'/pricing',
	'/@someone',
	'/@someone/example',
	'/login',
	'/@acme/-/approvals/bundle',
	'/@jane/example/approve-capabilities',
])('%s keeps its public or focused layout', (path) => {
	expect(workspaceLayoutNavigation(matches(path), session)).toBeNull()
})

test('a renamed person keeps the rail on their own profile', () => {
	const renamed = { ...session, username: 'jane-new' }
	expect(workspaceLayoutNavigation(matches('/@jane-new'), renamed)).toEqual({
		rail: 'workspace',
		item: 'public-profile',
		orgSlug: null,
		profileSlug: 'jane-new',
	})
	expect(workspaceLayoutNavigation(matches('/@someone'), renamed)).toBeNull()
})

test('the layout does not substitute for the existing authentication guards', () => {
	expect(workspaceLayoutNavigation(matches('/account'), null)).toBeNull()
})

test.each(['error', 'notFound'])(
	'%s uses the document error layout without a second main landmark',
	(status) => {
		const routeMatches = matches('/account')
		expect(
			workspaceLayoutNavigation(
				routeMatches.map((match, index) => ({
					...match,
					status: index === routeMatches.length - 1 ? status : 'success',
				})),
				session,
			),
		).toBeNull()
	},
)
