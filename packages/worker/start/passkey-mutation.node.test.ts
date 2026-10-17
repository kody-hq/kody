import { expect, test, vi } from 'vitest'
import {
	MutationObserver,
	QueryObserver,
	QueryClient,
} from '@tanstack/react-query'
import { passkeyMutationOptions } from './passkey-mutation.ts'

test('accepted passkey writes survive a failed confirmation read', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = ['page', 'actor-a', 'loadAccountSecurity', { slug: 'key-a' }]
	client.setQueryData(key, { passkeys: [] })
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
	const send = vi.fn(
		async (_input: { data: { passkeyId: string } }) => accepted,
	)
	const mutation = new MutationObserver(
		client,
		passkeyMutationOptions(client, key, send),
	)
	await expect(mutation.mutate({ passkeyId: 'key-a' })).resolves.toEqual(
		accepted,
	)
	expect(send).toHaveBeenCalledWith({ data: { passkeyId: 'key-a' } })
	expect(read).toHaveBeenCalledOnce()
	expect(client.getQueryState(key)?.status).toBe('error')
	unsubscribe()
	client.clear()
})

test.each(['accepted', 'lost response'])(
	'passkey writes keep their submitted actor after navigation: %s',
	async (outcome) => {
		const client = new QueryClient()
		const key = ['page', 'actor-a', 'loadAccountSecurity', { slug: 'key-a' }]
		const destination = [
			'page',
			'actor-b',
			'loadAccountSecurity',
			{ slug: 'key-b' },
		]
		const account = ['page', 'actor-a', 'loadAccountPage', undefined]
		const shell = ['shell', 'actor-a']
		const otherActor = [
			'page',
			'actor-b',
			'loadAccountSecurity',
			{ slug: 'key-a' },
		]
		for (const scope of [key, account, shell, destination, otherActor])
			client.setQueryData(scope, { passkeys: [] })
		let resolve!: (result: { ok: boolean }) => void
		let reject!: (error: Error) => void
		const send = vi.fn(
			(_input: { data: { passkeyId: string } }) =>
				new Promise<{ ok: boolean }>((yes, no) => {
					resolve = yes
					reject = no
				}),
		)
		const observer = new MutationObserver(
			client,
			passkeyMutationOptions(client, key, send),
		)
		const unsubscribe = observer.subscribe(() => {})
		const pending = observer.mutate({ passkeyId: 'key-a' })
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
		observer.setOptions(passkeyMutationOptions(client, destination, send))
		unsubscribe()
		if (outcome === 'accepted') {
			resolve({ ok: true })
			await pending
		} else {
			reject(new Error('Response lost'))
			await expect(pending).rejects.toThrow('Response lost')
		}
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryState(account)?.isInvalidated).toBe(true)
		expect(client.getQueryState(shell)?.isInvalidated).toBe(true)
		expect(client.getQueryState(destination)?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
		client.clear()
	},
)
