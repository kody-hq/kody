import { expect, test } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import {
	isPresentationNavigation,
	type CommittedPage,
} from './presentation-navigation.ts'

test('typing skips authority calls but selected, reentry, invalidation and actor changes verify', async () => {
	let actorKey = 'actor-a'
	let committed: CommittedPage | null = null
	const checks: string[] = []
	const root = createRootRoute({
		beforeLoad: ({ location, matches, preload }) => {
			if (
				!preload &&
				!isPresentationNavigation({ committed, location, matches, actorKey })
			)
				checks.push(location.href)
			return { actorKey }
		},
	})
	const jobs = createRoute({
		getParentRoute: () => root,
		path: '/@team/-/jobs',
		staticData: { presentationSearchKeys: ['q', 'view', 'selected'] },
		loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
			selected: search.selected,
		}),
		loader: () => ({}),
	})
	const home = createRoute({ getParentRoute: () => root, path: '/' })
	const router = createRouter({
		routeTree: root.addChildren([home, jobs]),
		history: createMemoryHistory({ initialEntries: ['/@team/-/jobs'] }),
		isServer: false,
		origin: 'https://test.local',
	})
	const commit = () => {
		committed = {
			location: router.state.location,
			matches: router.state.matches,
		}
	}
	await router.load()
	commit()
	for (const suffix of ['?q=a', '?q=ab', '?q=abc', '?q=abc&view=all']) {
		await router.navigate({ href: '/@team/-/jobs' + suffix, replace: true })
		commit()
	}
	expect(checks).toHaveLength(1)
	await router.navigate({ href: '/@team/-/jobs?selected=one' })
	commit()
	expect(checks).toHaveLength(2)
	await router.invalidate()
	commit()
	expect(checks).toHaveLength(3)
	actorKey = 'actor-b'
	await router.navigate({ href: '/@team/-/jobs?selected=one&q=x' })
	commit()
	expect(checks).toHaveLength(4)
	await router.navigate({ href: '/' })
	commit()
	await router.navigate({ href: '/@team/-/jobs?selected=one&q=x' })
	commit()
	expect(checks).toHaveLength(6)
	await router.navigate({ href: '/@team/-/jobs?selected=one&q=x&unknown=1' })
	commit()
	expect(checks).toHaveLength(7)
})

test('uncommitted, failed, invalid and different org snapshots cannot authorize presentation changes', () => {
	const match = {
		id: 'jobs',
		routeId: 'jobs',
		loaderDeps: {},
		invalid: false,
		status: 'success',
		error: undefined,
		context: { actorKey: 'actor' },
		staticData: { presentationSearchKeys: ['q'] },
	}
	const committed: CommittedPage = {
		location: { pathname: '/@team/-/jobs', searchStr: '', hash: '' },
		matches: [match],
	}
	const input = {
		committed,
		location: { ...committed.location, searchStr: '?q=filter' },
		matches: [match],
		actorKey: 'actor',
	}
	expect(isPresentationNavigation(input)).toBe(true)
	expect(isPresentationNavigation({ ...input, committed: null })).toBe(false)
	for (const change of [
		{ invalid: true },
		{ error: new Error('denied') },
		{ status: 'pending' },
	])
		expect(
			isPresentationNavigation({
				...input,
				committed: { ...committed, matches: [{ ...match, ...change }] },
			}),
		).toBe(false)
	expect(
		isPresentationNavigation({
			...input,
			matches: [{ ...match, invalid: true }],
		}),
	).toBe(false)
	expect(
		isPresentationNavigation({
			...input,
			location: { ...input.location, pathname: '/@other/-/jobs' },
		}),
	).toBe(false)
	expect(
		isPresentationNavigation({
			...input,
			location: { ...input.location, hash: 'detail' },
		}),
	).toBe(false)
})
