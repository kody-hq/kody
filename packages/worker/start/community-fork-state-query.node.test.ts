import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import type { CommunityForkState } from '#universal/community-public-types.ts'
import { refreshActiveQueries } from './refresh-active-queries.ts'

vi.mock('#start/server/community-mutations', () => ({
	loadCommunityForkState: vi.fn(),
}))

const { communityForkStateQuery, FORK_IN_PROGRESS_POLL_MS } =
	await import('./community-fork-state-query.ts')

type ForkStateQueryOptions = ReturnType<typeof communityForkStateQuery>

const done: CommunityForkState = {
	state: 'adaptation_required',
	targetName: '@viewer/demo',
	href: '/@viewer/demo',
}

function setup(states: Array<CommunityForkState>) {
	const client = new QueryClient()
	const load = vi.fn(async () => states.shift() ?? done)
	const options = communityForkStateQuery({
		actorKey: 'actor-1',
		listingId: 'listing-1',
		enabled: true,
		load,
	})
	return { client, load, options }
}

async function mount(client: QueryClient, options: ForkStateQueryOptions) {
	const observer = new QueryObserver(client, options)
	const results: Array<CommunityForkState | undefined> = []
	const unsubscribe = observer.subscribe((result) => {
		results.push(result.data as CommunityForkState | undefined)
	})
	await vi.waitFor(() =>
		expect(observer.getCurrentResult().fetchStatus).toBe('idle'),
	)
	return { observer, unsubscribe, results }
}

test('navigating away mid-fork and back re-reads fork state instead of trusting the cache', async () => {
	// First visit: nothing yet. While away, a fork started. Back: in progress.
	const { client, load, options } = setup([
		{ state: 'none' },
		{ state: 'in_progress', startedAt: '2026-10-23T18:49:00.000Z' },
	])
	const first = await mount(client, options)
	expect(first.observer.getCurrentResult().data).toEqual({ state: 'none' })
	first.unsubscribe()

	const back = await mount(client, options)
	expect(load).toHaveBeenCalledTimes(2)
	expect(back.observer.getCurrentResult().data).toEqual({
		state: 'in_progress',
		startedAt: '2026-10-23T18:49:00.000Z',
	})
	back.unsubscribe()
	client.clear()
})

test('an in-progress fork is polled and polling stops once the fork exists', () => {
	const { options } = setup([])
	const interval = options.refetchInterval as unknown as (query: {
		state: { data: CommunityForkState | undefined }
	}) => number | false
	expect(
		interval({
			state: {
				data: { state: 'in_progress', startedAt: '2026-10-23T18:49:00.000Z' },
			},
		}),
	).toBe(FORK_IN_PROGRESS_POLL_MS)
	expect(interval({ state: { data: done } })).toBe(false)
	expect(interval({ state: { data: { state: 'none' } } })).toBe(false)
	expect(interval({ state: { data: undefined } })).toBe(false)
	expect(options.staleTime).toBe(0)
	expect(options.refetchOnMount).toBe('always')
	expect(options.refetchOnWindowFocus).toBe('always')
})

test('focus or visibility return refetches fork state through the root activation refresh', async () => {
	const { client, load, options } = setup([{ state: 'none' }, done])
	const mounted = await mount(client, options)
	expect(load).toHaveBeenCalledTimes(1)
	await refreshActiveQueries(client, 'actor-1', async () => undefined)
	expect(load).toHaveBeenCalledTimes(2)
	expect(mounted.observer.getCurrentResult().data).toEqual(done)
	// Another actor's activation never refetches this viewer's state.
	await refreshActiveQueries(client, 'actor-2', async () => undefined)
	expect(load).toHaveBeenCalledTimes(2)
	mounted.unsubscribe()
	client.clear()
})

test('signed-out viewers never read fork state', () => {
	const options = communityForkStateQuery({
		actorKey: null,
		listingId: 'listing-1',
		enabled: false,
	})
	expect(options.enabled).toBe(false)
})
