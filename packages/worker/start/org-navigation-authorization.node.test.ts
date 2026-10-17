import { expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import { createPageQuery, loadPageQuery } from './page-query.ts'

const state = vi.hoisted(() => ({
	denied: false,
	suspended: false,
	deleting: false,
	grantOnly: false,
	destinations: [] as string[],
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (fn: typeof validate) => {
				validate = fn
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data?: unknown } = {}) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', () => ({ env: { COOKIE_SECRET: 'test' } }))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://kody.test/_serverFn/verify'),
}))
vi.mock('../src/app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('../src/app/auth-session.ts', () => ({ setAuthSessionSecret: vi.fn() }))
vi.mock('../src/app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: async () => ({
		user: {
			mcpUser: { userId: 'actor' },
			accountSuspended: state.suspended,
			accountDeleting: state.deleting,
		},
	}),
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: async (_db: unknown, _actor: string, slug: string) => {
		state.destinations.push(slug)
		return state.denied
			? null
			: {
					org: { id: 'org-team', slug },
					role: state.grantOnly ? null : 'owner',
				}
	},
}))
import { verifySession } from '#start/server/shell'

test('foreground org entry rechecks permission while an authorized warm entry reuses its payload', async () => {
	const client = new QueryClient()
	const read = vi.fn(async () => ({ payload: 'private jobs' }))
	const query = createPageQuery('loadJobsPage', read)
	const href = '/@team/-/jobs'
	const root = createRootRoute({
		notFoundComponent: () => null,
		beforeLoad: ({ location, preload }) =>
			!preload && location.pathname === href
				? verifySession({ data: { orgSlug: 'team', section: 'jobs' } })
				: undefined,
	})
	const jobs = createRoute({
		getParentRoute: () => root,
		path: href,
		loader: ({ preload }) =>
			loadPageQuery(client, query('actor', href), preload),
	})
	const home = createRoute({ getParentRoute: () => root, path: '/' })
	const router = createRouter({
		routeTree: root.addChildren([home, jobs]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
		isServer: false,
		origin: 'https://kody.test',
		defaultPreloadStaleTime: 0,
	})
	await router.load()
	await router.navigate({ href: href })
	expect(read).toHaveBeenCalledTimes(1)
	await router.navigate({ href: '/' })
	await router.navigate({ href: href })
	expect(read).toHaveBeenCalledTimes(1)
	expect(state.destinations).toEqual(['team', 'team'])
	await router.navigate({ href: '/' })
	state.denied = true
	await router.navigate({ href: href })
	expect(state.destinations).toEqual(['team', 'team', 'team'])
	expect(
		router.state.matches.some(
			(match) => match.status === 'notFound' || match._notFound,
		),
	).toBe(true)
	expect(read).toHaveBeenCalledTimes(1)
	client.clear()
})

test('fresh verification excludes suspended and deleting actors before organization reads', async () => {
	state.destinations = []
	state.suspended = true
	expect(
		await verifySession({ data: { orgSlug: 'team', section: 'jobs' } }),
	).toEqual({ actorKey: null })
	state.suspended = false
	state.deleting = true
	expect(
		await verifySession({ data: { orgSlug: 'team', section: 'jobs' } }),
	).toEqual({ actorKey: null })
	expect(state.destinations).toEqual([])
	state.deleting = false
})

test('grant-only access can reach own agents but cannot reuse private workspace lists', async () => {
	state.denied = false
	state.grantOnly = true
	await expect(
		verifySession({ data: { orgSlug: 'team', section: 'jobs' } }),
	).rejects.toMatchObject({ isNotFound: true })
	expect(
		await verifySession({ data: { orgSlug: 'team', section: 'agents' } }),
	).toEqual({ actorKey: 'actor' })
	state.grantOnly = false
})
