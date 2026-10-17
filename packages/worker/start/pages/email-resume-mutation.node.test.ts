import {
	MutationObserver,
	QueryClient,
	QueryObserver,
} from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { emailResumeMutationOptions } from './email-resume-mutation.ts'
import { emailKeys } from './email-resources.ts'
test('a lost resume response refreshes only the submitted actor and mailbox', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = [...emailKeys.all('person-a', 'team-a'), 'list']
	const otherActor = [...emailKeys.all('person-b', 'team-a'), 'list'],
		otherOrg = [...emailKeys.all('person-a', 'team-b'), 'list']
	for (const queryKey of [key, otherActor, otherOrg])
		client.setQueryData(queryKey, { outboundDeliveryPausedAt: 'before' })
	const observer = new QueryObserver(client, {
		queryKey: key,
		staleTime: Infinity,
		queryFn: async () => ({ outboundDeliveryPausedAt: null }),
	})
	const unsubscribe = observer.subscribe(() => {})
	const lost = new Error('Response lost')
	const mutation = new MutationObserver(
		client,
		emailResumeMutationOptions(client, async () => {
			throw lost
		}),
	)
	await expect(
		mutation.mutate({ actorKey: 'person-a', orgSlug: 'team-a' }),
	).rejects.toBe(lost)
	expect(client.getQueryData(key)).toEqual({ outboundDeliveryPausedAt: null })
	for (const queryKey of [otherActor, otherOrg]) {
		expect(client.getQueryData(queryKey)).toEqual({
			outboundDeliveryPausedAt: 'before',
		})
		expect(client.getQueryState(queryKey)?.isInvalidated).toBe(false)
	}
	unsubscribe()
	client.clear()
})
