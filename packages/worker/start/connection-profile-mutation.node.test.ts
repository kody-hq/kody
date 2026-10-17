import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { connectionProfileMutationOptions } from './connection-profile-mutation.ts'
import { createPageQuery, ensurePageQuery } from './page-query.ts'

test.each([false, true])(
	'uncached connection navigation survives settlement, lost response: %s',
	async (lost) => {
		const client = new QueryClient()
		let completeWrite!: () => void
		const mutation = new MutationObserver(client, {
			...connectionProfileMutationOptions(client, 'actor-a', 'org-a'),
			mutationFn: async () => {
				await new Promise<void>((resolve) => {
					completeWrite = resolve
				})
				if (lost) throw new Error('Response lost')
				return { ok: true }
			},
		})
		const submitted = mutation.mutate(undefined).catch(() => undefined)
		await vi.waitFor(() => expect(completeWrite).toBeTypeOf('function'))
		const read = vi.fn(async () => ({ profiles: ['saved-profile'] }))
		const options = createPageQuery('loadConnectionsPage', read)('actor-a', {
			orgSlug: 'org-a',
		})
		const navigation = ensurePageQuery(client, options, false)
		await Promise.resolve()
		await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
		completeWrite()
		await submitted
		await expect(navigation).resolves.toEqual({ profiles: ['saved-profile'] })
		expect(read).toHaveBeenCalledTimes(2)
		client.clear()
	},
)
