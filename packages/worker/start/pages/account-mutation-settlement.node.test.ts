import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import {
	settleAccountMutation,
	profileResources,
	accountConnectionResources,
	jobResources,
} from './account-mutation-settlement.ts'

for (const [family, resources, orgSlug] of [
	['profile', profileResources, undefined],
	['accountConnections', accountConnectionResources, undefined],
	['jobs', jobResources, 'submitted-org'],
] as const) {
	for (const readBeforeWrite of [true, false]) {
		test.each(['accepted', 'lost response'] as const)(
			`${family} confirms inactive first navigation, read before write: ${readBeforeWrite}, %s`,
			async (outcome) => {
				const client = new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
				const key = [
					'page',
					'submitted-actor',
					resources[0],
					{ orgSlug: orgSlug ?? null },
				]
				let finishRead!: (value: string) => void
				let finishWrite!: () => void
				let failWrite!: (error: Error) => void
				const read = vi
					.fn<() => Promise<string>>()
					.mockImplementationOnce(
						() =>
							new Promise((resolve) => {
								finishRead = resolve
							}),
					)
					.mockResolvedValue('persisted')
				const observer = new MutationObserver(client, {
					mutationKey: [family, 'submitted-actor', orgSlug],
					mutationFn: () =>
						new Promise<void>((resolve, reject) => {
							finishWrite = resolve
							failWrite = reject
						}),
					onSettled: () =>
						settleAccountMutation(client, 'submitted-actor', resources, {
							orgSlug,
						}),
				})
				const write = observer.mutate().catch(() => undefined)
				await vi.waitFor(() => expect(finishWrite).toBeDefined())
				const navigation = client.ensureQueryData({
					queryKey: key,
					queryFn: read,
					staleTime: Infinity,
				})
				await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
				const otherActor = [
					'page',
					'other-actor',
					resources[0],
					{ orgSlug: orgSlug ?? null },
				]
				const unrelated = ['page', 'submitted-actor', 'loadDocs', {}]
				const otherOrg = [
					'page',
					'submitted-actor',
					resources[0],
					{ orgSlug: 'other-org' },
				]
				client.setQueryData(otherActor, 'unchanged')
				client.setQueryData(unrelated, 'unchanged')
				if (orgSlug) client.setQueryData(otherOrg, 'unchanged')
				if (readBeforeWrite) {
					finishRead('before')
					await expect(navigation).resolves.toBe('before')
				}
				if (outcome === 'accepted') finishWrite()
				else failWrite(new Error('Reply lost after commit'))
				if (!readBeforeWrite) {
					await Promise.resolve()
					expect(observer.getCurrentResult().isPending).toBe(true)
					finishRead('before')
					await expect(navigation).resolves.toBe('before')
				}
				await write
				expect(read).toHaveBeenCalledTimes(2)
				expect(client.getQueryData(key)).toBe('persisted')
				expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
				expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false)
				if (orgSlug)
					expect(client.getQueryState(otherOrg)?.isInvalidated).toBe(false)
				expect(observer.getCurrentResult().isPending).toBe(false)
				client.clear()
			},
		)
	}
}
