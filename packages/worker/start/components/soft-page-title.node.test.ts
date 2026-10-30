import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { notFound } from '@tanstack/react-router'

const mocks = vi.hoisted(() => ({
	client: undefined as unknown,
	router: { state: {} as Record<string, unknown> },
	effects: [] as Array<() => void | (() => void)>,
}))
vi.mock('react', async (original) => ({
	...(await original<Record<string, unknown>>()),
	useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
}))
vi.mock('@tanstack/react-query', async (original) => ({
	...(await original<Record<string, unknown>>()),
	useQueryClient: () => mocks.client,
}))
vi.mock('@tanstack/react-router', async (original) => ({
	...(await original<Record<string, unknown>>()),
	useRouter: () => mocks.router,
	useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
		select(mocks.router.state),
}))
import { SoftPageTitle } from './soft-page-title.tsx'

let client: QueryClient
let cleanup: void | (() => void)
const key = ['page', 'actor-a', 'loadProfile', 'alice']
const oldHead = {
	title: 'Alice',
	description: 'SSR description',
	canonicalUrl: 'https://kody.test/@alice',
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	mocks.client = client
	mocks.effects = []
	mocks.router.state = {
		location: { href: '/@alice' },
		matches: [
			{
				status: 'success',
				context: {},
				loaderData: { head: oldHead, pageHeadQueryKey: key },
			},
		],
	}
	vi.stubGlobal('document', { title: 'Alice' })
	client.setQueryData(key, { head: oldHead })
})
afterEach(() => {
	cleanup?.()
	cleanup = undefined
	client.clear()
	vi.unstubAllGlobals()
})
function mount(overrideTitle?: string) {
	SoftPageTitle({ overrideTitle })
	cleanup = mocks.effects.at(-1)!()
}

test('soft edits update only the title, leaving the loader metadata snapshot intact', () => {
	mount()
	client.setQueryData(key, {
		head: {
			...oldHead,
			title: 'Alice renamed',
			description: 'New description',
		},
	})
	expect(document.title).toBe('Alice renamed')
	expect(oldHead).toEqual({
		title: 'Alice',
		description: 'SSR description',
		canonicalUrl: 'https://kody.test/@alice',
	})
	client.setQueryData(['page', 'actor-b', 'loadProfile', 'alice'], {
		head: { title: 'Another account' },
	})
	expect(document.title).toBe('Alice renamed')
})

test('late writes cannot overwrite the destination title, including a same-URL account change', () => {
	mount()
	mocks.router.state = {
		...mocks.router.state,
		matches: [{ status: 'success', context: { actorKey: 'actor-b' } }],
	}
	document.title = 'Destination'
	client.setQueryData(key, { head: { title: 'Late result' } })
	expect(document.title).toBe('Destination')
})

test('unmount removes the subscription', () => {
	mount()
	cleanup?.()
	cleanup = undefined
	document.title = 'Pricing'
	client.setQueryData(key, { head: { title: 'Late result' } })
	expect(document.title).toBe('Pricing')
})

test('denied soft reads replace the title and cache removal cannot restore a stale title', async () => {
	mount()
	await expect(
		client.fetchQuery({
			queryKey: key,
			queryFn: () => {
				throw notFound()
			},
		}),
	).rejects.toBeDefined()
	expect(document.title).toBe('Not found')
	client.removeQueries({ queryKey: key })
	expect(document.title).toBe('Not found')
})

test('filtered context selects the current resource and infinite pages use their first title', () => {
	const filtered = [...key, 'filtered']
	const match = (
		mocks.router.state.matches as Array<Record<string, unknown>>
	)[0]!
	match.context = { pageHeadQueryKey: filtered }
	client.setQueryData(filtered, {
		pages: [{ head: { title: 'Filtered activity' } }],
	})
	mount()
	expect(document.title).toBe('Filtered activity')
	client.setQueryData(key, { head: { title: 'Old filter' } })
	expect(document.title).toBe('Filtered activity')
})

test('route failures take priority over retained query data', () => {
	mount('Unauthorized | Kody')
	client.setQueryData(key, { head: { title: 'Retained private title' } })
	expect(document.title).toBe('Unauthorized | Kody')
})
