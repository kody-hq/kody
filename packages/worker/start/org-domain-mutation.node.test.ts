import { expect, test, vi } from 'vitest'
import {
	MutationObserver,
	QueryObserver,
	QueryClient,
} from '@tanstack/react-query'
import { orgDomainMutationOptions } from './pages/org-domain-mutation.ts'

test('accepted domain writes survive a failed confirmation read', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = ['page', 'actor-a', 'loadOrgSettings', { slug: 'team-a' }]
	client.setQueryData(key, { customDomains: [] })
	const read = vi.fn(async () => {
		throw new Error('Read temporarily unavailable')
	})
	const page = new QueryObserver(client, {
		queryKey: key,
		queryFn: read,
		staleTime: Infinity,
	})
	const unsubscribe = page.subscribe(() => {})
	const accepted = { ok: true }
	const send = vi.fn(async (_input: { data: { orgSlug: string } }) => accepted)
	const mutation = new MutationObserver(
		client,
		orgDomainMutationOptions(client, key, send),
	)
	await expect(mutation.mutate({ orgSlug: 'team-a' })).resolves.toEqual(
		accepted,
	)
	expect(send).toHaveBeenCalledWith({ data: { orgSlug: 'team-a' } })
	expect(read).toHaveBeenCalledOnce()
	expect(client.getQueryState(key)?.status).toBe('error')
	unsubscribe()
	client.clear()
})

test.each(['accepted', 'lost response'])(
	'domain writes keep their submitted actor and organization after navigation: %s',
	async (outcome) => {
		const client = new QueryClient()
		const key = ['page', 'actor-a', 'loadOrgSettings', { slug: 'team-a' }]
		const destination = [
			'page',
			'actor-a',
			'loadOrgSettings',
			{ slug: 'team-b' },
		]
		const otherActor = [
			'page',
			'actor-b',
			'loadOrgSettings',
			{ slug: 'team-a' },
		]
		for (const scope of [key, destination, otherActor])
			client.setQueryData(scope, { customDomains: [] })
		let resolve!: (result: { ok: boolean }) => void
		let reject!: (error: Error) => void
		const send = vi.fn(
			(_input: { data: { orgSlug: string } }) =>
				new Promise<{ ok: boolean }>((yes, no) => {
					resolve = yes
					reject = no
				}),
		)
		const observer = new MutationObserver(
			client,
			orgDomainMutationOptions(client, key, send),
		)
		const unsubscribe = observer.subscribe(() => {})
		const pending = observer.mutate({ orgSlug: 'team-a' })
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
		observer.setOptions(orgDomainMutationOptions(client, destination, send))
		unsubscribe()
		if (outcome === 'accepted') {
			resolve({ ok: true })
			await pending
		} else {
			reject(new Error('Response lost'))
			await expect(pending).rejects.toThrow('Response lost')
		}
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryState(destination)?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
		client.clear()
	},
)
