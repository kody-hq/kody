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

it('email search preserves Router text values that resemble parsed types', () => {
	for (const q of ['true', 'null', '"hello"', '[]', '{}', ' 123 ']) {
		const parsed = defaultParseSearch(defaultStringifySearch({ q }))
		expect(emailSearch(parsed).q).toBe(q)
	}
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
		view: 'inbox',
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

it('a missing email:read grant resolves the loader as data so the route does not fail', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	vi.mocked(loadEmailList).mockResolvedValue({ missingGrant: 'email:read' })
	vi.mocked(loadEmailDetail).mockResolvedValue(null)
	vi.mocked(loadEmailDestinations).mockResolvedValue({
		ok: true,
		destinations: [],
		additionalLimit: 3,
		additionalRemaining: 3,
	})
	const input = emailResourceInput(
		{ orgSlug: 'tanstack', messageId: 'm1' },
		emailSearch({}),
	)
	await expect(
		loadEmailResources(client, 'member', input),
	).resolves.toBeUndefined()
	expect(client.getQueryData(emailKeys.list('member', input.list))).toEqual({
		missingGrant: 'email:read',
	})
	client.clear()
})
