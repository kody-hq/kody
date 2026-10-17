import {
	QueryClient,
	MutationObserver,
	QueryObserver,
} from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { conversionMutationOptions } from './convert-personal-org-mutation.ts'
const input = {
	data: { newHandle: 'new-handle', confirmation: 'convert @old-handle' },
	actorKey: 'person-a',
}
test('conversion cancels even uncached old-identity reads and invalidates only the submitted person', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const own = ['page', 'person-a', 'personalResource'],
		other = ['page', 'person-b', 'personalResource'],
		shell = ['shell', 'person-a', '']
	client.setQueryDefaults(other, { meta: { actorKey: 'person-b' } })
	client.setQueryData(other, { owner: 'other-person' })
	client.setQueryDefaults(shell, { meta: { actorKey: 'person-a' } })
	client.setQueryData(shell, { username: 'old-handle' })
	let finish!: (value: string) => void
	let signal!: AbortSignal
	const read = client
		.fetchQuery({
			queryKey: own,
			meta: { actorKey: 'person-a' },
			queryFn: (context) => {
				signal = context.signal
				return new Promise<string>((resolve) => {
					finish = resolve
				})
			},
		})
		.catch((error) => error)
	const result = {
		ok: true,
		newUsername: 'new-handle',
		followUpFailures: ['email_inbox'],
	}
	const mutation = new MutationObserver(
		client,
		conversionMutationOptions(
			client,
			vi.fn(async () => result),
		),
	)
	expect(await mutation.mutate(input)).toEqual(result)
	expect(signal.aborted).toBe(true)
	finish('old-personal-org')
	await read
	expect(client.getQueryData(own)).toBeUndefined()
	expect(client.getQueryState(shell)?.isInvalidated).toBe(true)
	expect(client.getQueryData(other)).toEqual({ owner: 'other-person' })
	expect(client.getQueryState(other)?.isInvalidated).toBe(false)
	client.clear()
})
test('a lost conversion response preserves its error while refreshing current identity', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = ['shell', 'person-a', '']
	client.setQueryDefaults(key, { meta: { actorKey: 'person-a' } })
	client.setQueryData(key, { username: 'old-handle' })
	const observer = new QueryObserver(client, {
		queryKey: key,
		meta: { actorKey: 'person-a' },
		staleTime: Infinity,
		queryFn: async () => ({ username: 'new-handle' }),
	})
	const unsubscribe = observer.subscribe(() => {})
	const failure = new Error('Response lost')
	const mutation = new MutationObserver(
		client,
		conversionMutationOptions(client, async () => {
			throw failure
		}),
	)
	await expect(mutation.mutate(input)).rejects.toBe(failure)
	expect(client.getQueryData(key)).toEqual({ username: 'new-handle' })
	unsubscribe()
	client.clear()
})

test('a committed conversion keeps follow-up warnings when the confirming read fails', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = ['shell', 'person-a', '']
	client.setQueryDefaults(key, { meta: { actorKey: 'person-a' } })
	client.setQueryData(key, { username: 'old-handle' })
	const observer = new QueryObserver(client, {
		queryKey: key,
		meta: { actorKey: 'person-a' },
		staleTime: Infinity,
		queryFn: async () => {
			throw new Error('Refresh unavailable')
		},
	})
	const unsubscribe = observer.subscribe(() => {})
	const accepted = {
		ok: true,
		newUsername: 'new-handle',
		followUpFailures: ['memory_index'],
	}
	const mutation = new MutationObserver(
		client,
		conversionMutationOptions(client, async () => accepted),
	)
	await expect(mutation.mutate(input)).resolves.toEqual(accepted)
	expect(client.getQueryState(key)?.status).toBe('error')
	unsubscribe()
	client.clear()
})
