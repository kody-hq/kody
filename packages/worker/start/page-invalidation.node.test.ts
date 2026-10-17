import { describe, expect, it, test } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'

describe('mutation resource invalidation', () => {
	it('refreshes the affected active resource once and marks its inactive variants stale without reading unrelated pages', async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity, retry: false } },
		})
		const active = ['page', 'alice', 'loadMemoriesPage', '/account/memories']
		const detail = [
			'page',
			'alice',
			'loadMemoriesPage',
			'/account/memories/one',
		]
		const unrelated = ['page', 'alice', 'loadJobsPage', '/account/jobs']
		const otherActor = ['page', 'bob', 'loadMemoriesPage', '/account/memories']
		for (const key of [active, detail, unrelated, otherActor])
			client.setQueryData(key, 'before')
		let reads = 0
		const observer = new QueryObserver(client, {
			queryKey: active,
			queryFn: async () => {
				reads++
				return 'after'
			},
		})
		const unsubscribe = observer.subscribe(() => {})
		await invalidatePageResources(client, 'alice', ['loadMemoriesPage'])
		expect(reads).toBe(1)
		expect(client.getQueryData(active)).toBe('after')
		expect(client.getQueryState(detail)?.isInvalidated).toBe(true)
		expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
		unsubscribe()
		client.clear()
	})

	it('lets Router own a metadata refresh without first issuing a duplicate Query read', async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity } },
		})
		const key = ['page', 'alice', 'loadProfile', { username: 'alice' }]
		client.setQueryData(key, 'before')
		let reads = 0
		const options = {
			queryKey: key,
			queryFn: async () => {
				reads++
				return 'after'
			},
		}
		const observer = new QueryObserver(client, options)
		const unsubscribe = observer.subscribe(() => {})
		await invalidatePageResources(client, 'alice', ['loadProfile'], 'none')
		expect(reads).toBe(0)
		await client.fetchQuery(options)
		expect(reads).toBe(1)
		unsubscribe()
		client.clear()
	})

	it('explicit permission changes invalidate every owned resource for that actor only', async () => {
		const client = new QueryClient()
		const keys = [
			['page', 'alice', 'loadSecretsPage'],
			['page', 'alice', 'loadPackage'],
			['page', 'bob', 'loadPackage'],
			['shell', 'alice'],
			['email', 'alice', 'team', 'list'],
			['email-destinations', 'alice'],
			['email', 'bob', 'team', 'list'],
		]
		for (const key of keys) {
			client.setQueryDefaults(key, { meta: { actorKey: key[1] } })
			client.setQueryData(key, {})
		}
		await invalidatePageResources(client, 'alice', 'permissions', 'none')
		expect(keys.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual(
			[true, true, false, true, true, true, false],
		)
		client.clear()
	})
	it('retires a cached pre-write read before the Router confirmation and ignores its late response', async () => {
		const client = new QueryClient()
		const key = ['page', 'alice', 'loadProfile', { username: 'alice' }]
		client.setQueryData(key, 'before')
		let releaseOld!: (value: string) => void
		let oldSignal: AbortSignal | undefined
		const old = client
			.fetchQuery({
				queryKey: key,
				queryFn: ({ signal }) => {
					oldSignal = signal
					return new Promise<string>((resolve) => {
						releaseOld = resolve
					})
				},
			})
			.catch(() => undefined)
		await invalidatePageResources(client, 'alice', ['loadProfile'], 'none')
		expect(oldSignal?.aborted).toBe(true)
		const confirmed = await client.fetchQuery({
			queryKey: key,
			queryFn: async () => 'accepted',
		})
		releaseOld('old server snapshot')
		await old
		expect(confirmed).toBe('accepted')
		expect(client.getQueryData(key)).toBe('accepted')
		client.clear()
	})

	it('preserves an uncached navigation waiting for the mutation to settle', async () => {
		const client = new QueryClient()
		const key = ['page', 'alice', 'loadProfile', { username: 'alice' }]
		let release!: (value: string) => void
		let signal: AbortSignal | undefined
		let reads = 0
		const options = {
			queryKey: key,
			queryFn: (context: { signal: AbortSignal }) => {
				reads++
				signal = context.signal
				return new Promise<string>((resolve) => {
					release = resolve
				})
			},
		}
		const navigation = client.fetchQuery(options)
		await invalidatePageResources(client, 'alice', ['loadProfile'], 'none')
		expect(signal?.aborted).toBe(false)
		const confirmation = client.fetchQuery(options)
		release('accepted')
		expect(await navigation).toBe('accepted')
		expect(await confirmation).toBe('accepted')
		expect(reads).toBe(1)
		client.clear()
	})
})

it('an organization write only invalidates that organization resource', async () => {
	const client = new QueryClient()
	const acme = ['page', 'actor', 'loadJobsPage', { orgSlug: 'acme' }] as const
	const other = ['page', 'actor', 'loadJobsPage', { orgSlug: 'other' }] as const
	client.setQueryData(acme, { messages: [] })
	client.setQueryData(other, { messages: [] })
	await invalidatePageResources(client, 'actor', ['loadJobsPage'], 'none', {
		orgSlug: 'acme',
	})
	expect(client.getQueryState(acme)?.isInvalidated).toBe(true)
	expect(client.getQueryState(other)?.isInvalidated).toBe(false)
	client.clear()
})

it('cross-surface writes without org identity invalidate named resources across the actor caches', async () => {
	const client = new QueryClient()
	const keys = [
		['page', 'actor', 'loadSecretsPage', { orgSlug: 'acme' }],
		['page', 'actor', 'loadSecretsPage', { orgSlug: 'other' }],
		['page', 'other-actor', 'loadSecretsPage', { orgSlug: 'acme' }],
		['page', 'actor', 'loadJobsPage', { orgSlug: 'acme' }],
	]
	for (const key of keys) client.setQueryData(key, {})
	await invalidatePageResources(
		client,
		'actor',
		['loadSecretsPage'],
		'none',
		undefined,
	)
	expect(keys.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([
		true,
		true,
		false,
		false,
	])
	client.clear()
})

test('typed collection inputs invalidate the submitting actor and org only', async () => {
	const client = new QueryClient()
	const keys = [
		['page', 'alice', 'loadMemoriesPage', { orgSlug: 'team', query: '' }],
		['page', 'alice', 'loadMemoriesPage', { orgSlug: 'team', memoryId: 'one' }],
		['page', 'alice', 'loadMemoriesPage', { orgSlug: 'other', query: '' }],
		['page', 'bob', 'loadMemoriesPage', { orgSlug: 'team', query: '' }],
	]
	for (const key of keys) client.setQueryData(key, {})
	await invalidatePageResources(client, 'alice', ['loadMemoriesPage'], 'none', {
		orgSlug: 'team',
	})
	expect(keys.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([
		true,
		true,
		false,
		false,
	])
	client.clear()
})
