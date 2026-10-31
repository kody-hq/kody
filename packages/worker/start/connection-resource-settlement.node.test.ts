import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { integrationMutationOptions } from './integration-mutation.ts'

const key = (resource: string, actor = 'actor', org = 'org') =>
	['page', actor, resource, { orgSlug: org }] as const
for (const lost of [false, true]) {
	test(`integrations confirms an uncached navigation after ${lost ? 'lost response' : 'success'} without canceling it`, async () => {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
		const resource = 'loadIntegrationsPage'
		let releaseWrite!: () => void
		let releaseRead!: () => void
		let committed = false
		const write = async () => {
			await new Promise<void>((resolve) => {
				releaseWrite = resolve
			})
			committed = true
			if (lost) throw new Error('Response lost')
		}
		const mutation = new MutationObserver(
			client,
			integrationMutationOptions(client),
		)
		const completion = mutation
			.mutate({ actorKey: 'actor', orgSlug: 'org', write })
			.catch(() => undefined)
		await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'), {
			interval: 1,
		})
		const read = vi.fn(async () => {
			const snapshot = committed
			if (!snapshot)
				await new Promise<void>((resolve) => {
					releaseRead = resolve
				})
			return snapshot
		})
		const first = client.fetchQuery({
			queryKey: key(resource),
			queryFn: read,
		})
		await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'), {
			interval: 1,
		})
		releaseWrite()
		await Promise.resolve()
		releaseRead()
		await expect(first).resolves.toBe(false)
		await completion
		expect(read).toHaveBeenCalledTimes(2)
		expect(client.getQueryData(key(resource))).toBe(true)
		client.clear()
	})
}

test('undo never sends the integration write and still confirms the current collection', async () => {
	const client = new QueryClient()
	const read = vi.fn(async () => 'current')
	await client.fetchQuery({
		queryKey: key('loadIntegrationsPage'),
		queryFn: read,
	})
	const write = vi.fn()
	const mutation = new MutationObserver(
		client,
		integrationMutationOptions(client),
	)
	await mutation.mutate({
		actorKey: 'actor',
		orgSlug: 'org',
		write,
		decision: Promise.resolve(false),
		removeNames: ['one'],
	})
	expect(write).not.toHaveBeenCalled()
	expect(read).toHaveBeenCalledTimes(2)
	client.clear()
})
