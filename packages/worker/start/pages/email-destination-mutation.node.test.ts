import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { emailDestinationMutationOptions } from './email-destination-mutation.ts'
import { emailKeys } from './email-resources.ts'

test.each([null, new Error('Response lost')])(
	'destination settlement reconciles the submitting account after switching accounts: %s',
	async (error) => {
		const client = new QueryClient()
		const original = emailKeys.destinations('original')
		const current = emailKeys.destinations('current')
		client.setQueryData(original, { destinations: [] })
		client.setQueryData(current, { destinations: [] })
		const submission = await emailDestinationMutationOptions(
			client,
			'original',
		).onMutate()
		// Mutation observers can receive new options while the request is pending.
		await emailDestinationMutationOptions(client, 'current').onSettled(
			undefined,
			error,
			undefined,
			submission,
		)
		expect(client.getQueryState(original)?.isInvalidated).toBe(true)
		expect(client.getQueryState(current)?.isInvalidated).toBe(false)
		client.clear()
	},
)
