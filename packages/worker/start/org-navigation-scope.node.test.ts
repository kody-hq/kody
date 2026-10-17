import { expect, test } from 'vitest'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { orgNavigationScope } from './org-navigation-scope.ts'

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})

test('native policies supply organization and section independently of route names', () => {
	expect(
		orgNavigationScope([
			{
				staticData: { orgScope: { section: 'jobs' } },
				params: { orgSlug: 'acme', jobId: 'one' },
			},
		]),
	).toEqual({ orgSlug: 'acme', section: 'jobs' })
	expect(
		orgNavigationScope([
			{ staticData: { orgScope: {} }, params: { orgSlug: 'acme' } },
		]),
	).toEqual({ orgSlug: 'acme', section: undefined })
	expect(
		orgNavigationScope([{ staticData: {}, params: { orgSlug: 'acme' } }]),
	).toBeUndefined()
	expect(
		orgNavigationScope([
			{ staticData: { orgScope: {} }, params: { username: 'acme' } },
		]),
	).toBeUndefined()
	expect(
		orgNavigationScope([{ staticData: { orgScope: {} }, params: null }]),
	).toBeUndefined()
	expect(
		orgNavigationScope([
			{ staticData: { orgScope: {} }, params: { orgSlug: 42 } },
		]),
	).toBeUndefined()
	expect(
		orgNavigationScope([
			{
				staticData: { orgScope: { section: 'jobs' } },
				params: { orgSlug: 'first' },
			},
			{
				staticData: { orgScope: { section: 'workflows' } },
				params: { orgSlug: 'second' },
			},
		]),
	).toEqual({ orgSlug: 'second', section: 'workflows' })
})

test('every native organization route declares its verification policy', () => {
	const sections = new Set([
		'activity',
		'agents',
		'credentials',
		'email',
		'follows',
		'integrations',
		'jobs',
		'mcp-servers',
		'memories',
		'repositories',
		'secret-providers',
		'secrets',
		'waiting',
		'webhooks',
		'workflows',
	])
	const orgRoutes = Object.values(router.routesById).filter((route) =>
		route.fullPath.startsWith('/@{$orgSlug}/-/'),
	)
	expect(orgRoutes.length).toBeGreaterThan(50)
	for (const route of orgRoutes) {
		const section = route.fullPath.split('/-/')[1]!.split('/')[0]!
		expect(route.options.staticData?.orgScope).toEqual(
			sections.has(section) ? { section } : {},
		)
	}
})

test('package and personal routes cannot inherit org membership scope by naming coincidence', () => {
	for (const href of ['/@acme/jobs', '/account/jobs', '/@acme']) {
		const [routes, params] = router.getMatchedRoutes(href)
		expect(
			orgNavigationScope(
				routes.map((route) => ({
					staticData: route.options.staticData ?? {},
					params,
				})),
			),
		).toBeUndefined()
	}
})
