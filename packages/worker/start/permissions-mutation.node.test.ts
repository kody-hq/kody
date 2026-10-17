import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { permissionsMutationOptions } from './permissions-mutation.ts'

test.each([null, new Error('Response lost')])(
	'permission settlement refreshes resource caches for the submitting actor: %s',
	async (error) => {
		const client = new QueryClient()
		const keys = [
			['page', 'alice', 'loadAccountPage'],
			['email', 'alice', 'acme', 'list'],
			['email-destinations', 'alice'],
			['shell', 'alice'],
			['page', 'bob', 'loadAccountPage'],
			['email', 'bob', 'acme', 'list'],
		] as const
		for (const key of keys) {
			client.setQueryDefaults(key, { meta: { actorKey: key[1] } })
			client.setQueryData(key, { protected: true })
		}
		const submitted = await permissionsMutationOptions(
			client,
			'alice',
		).onMutate()
		// A retained observer may receive options for a different signed-in actor.
		await permissionsMutationOptions(client, 'bob').onSettled(
			undefined,
			error,
			undefined,
			submitted,
		)
		for (const key of keys)
			expect(client.getQueryState(key)?.isInvalidated).toBe(key[1] === 'alice')
		client.clear()
	},
)

test('permission settlement cancels an older protected resource response', async () => {
	const client = new QueryClient()
	const key = ['email', 'alice', 'acme', 'list'] as const
	client.setQueryDefaults(key, { meta: { actorKey: 'alice' } })
	client.setQueryData(key, { version: 'before' })
	let resolve!: (data: { version: string }) => void
	const pending = client
		.fetchQuery({
			queryKey: key,
			queryFn: () =>
				new Promise<{ version: string }>((done) => {
					resolve = done
				}),
		})
		.catch(() => undefined)
	const submitted = await permissionsMutationOptions(client, 'alice').onMutate()
	await permissionsMutationOptions(client, 'alice').onSettled(
		undefined,
		null,
		undefined,
		submitted,
	)
	resolve({ version: 'stale' })
	await pending
	expect(client.getQueryData(key)).toEqual({ version: 'before' })
	expect(client.getQueryState(key)?.isInvalidated).toBe(true)
	client.clear()
})
