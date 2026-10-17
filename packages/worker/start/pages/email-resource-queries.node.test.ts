import {
	emailKeys,
	emailResourceInput,
	emailSearch,
} from './email-resources.ts'
import { expect, it, vi } from 'vitest'
import {
	defaultParseSearch,
	defaultStringifySearch,
} from '@tanstack/react-router'
import { QueryClient, dehydrate } from '@tanstack/react-query'
import { loadEmailResources } from './email-resource-queries.ts'
import {
	loadEmailList,
	loadEmailDetail,
	loadEmailDestinations,
} from '#start/server/email'

it.each(['123', 'true', 'false', 'null', '"hello"', '[]', '{}', ' 123 '])(
	'email search preserves Router text %s',
	(q) => {
		const parsed = defaultParseSearch(defaultStringifySearch({ q }))
		expect(emailSearch(parsed).q).toBe(q)
	},
)

it.each(['123', 'true', 'null'])('email bookmarks retain text %s', (q) => {
	expect(emailSearch(defaultParseSearch(`?q=${q}`)).q).toBe(q)
})
vi.mock('#start/server/email', () => ({
	loadEmailList: vi.fn(),
	loadEmailDetail: vi.fn(),
	loadEmailDestinations: vi.fn(),
}))

it('starts independent reads together and reuses list and destinations when selecting another message', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	let resolveList!: (value: Awaited<ReturnType<typeof loadEmailList>>) => void
	let resolveDetail!: (
		value: Awaited<ReturnType<typeof loadEmailDetail>>,
	) => void
	let resolveDestinations!: (
		value: Awaited<ReturnType<typeof loadEmailDestinations>>,
	) => void
	vi.mocked(loadEmailList).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveList = resolve
			}),
	)
	vi.mocked(loadEmailDetail).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveDetail = resolve
			}),
	)
	vi.mocked(loadEmailDestinations).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveDestinations = resolve
			}),
	)
	const first = loadEmailResources(
		client,
		'actor',
		emailResourceInput(
			{ orgSlug: 'acme', messageId: 'one' },
			emailSearch({ q: 'hello' }),
		),
	)
	await vi.waitFor(() => {
		expect(loadEmailList).toHaveBeenCalledOnce()
		expect(loadEmailDetail).toHaveBeenCalledOnce()
		expect(loadEmailDestinations).toHaveBeenCalledOnce()
	})
	resolveList({
		ok: true,
		emailVerified: true,
		email: 'a@example.com',
		username: 'a',
		inboxAddress: null,
		verificationMessage: null,
		outboundDeliveryPausedAt: null,
		inboxes: [],
		messages: [],
		usage: null,
		page: 1,
		pageSize: 25,
		total: 0,
		query: 'hello',
		classification: null,
	})
	resolveDetail(null)
	resolveDestinations({
		ok: true,
		destinations: [],
		additionalLimit: 3,
		additionalRemaining: 3,
	})
	await first
	// Router's loader fills the same Query cache used by SSR dehydration.
	// Destinations must be included even before their UI is mounted.
	expect(dehydrate(client).queries).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				queryKey: emailKeys.destinations('actor'),
				state: expect.objectContaining({
					data: {
						ok: true,
						destinations: [],
						additionalLimit: 3,
						additionalRemaining: 3,
					},
				}),
			}),
		]),
	)
	vi.mocked(loadEmailDetail).mockResolvedValue(null)
	await loadEmailResources(
		client,
		'actor',
		emailResourceInput(
			{ orgSlug: 'acme', messageId: 'two' },
			emailSearch({ q: ' hello ', page: '01' }),
		),
	)
	expect(loadEmailList).toHaveBeenCalledOnce()
	expect(loadEmailDestinations).toHaveBeenCalledOnce()
	expect(loadEmailDetail).toHaveBeenCalledTimes(2)
	await loadEmailResources(
		client,
		'actor',
		emailResourceInput(
			{ orgSlug: 'acme', messageId: 'one' },
			emailSearch({ q: 'hello' }),
		),
	)
	expect(loadEmailDetail).toHaveBeenCalledTimes(2)
	client.clear()
})
