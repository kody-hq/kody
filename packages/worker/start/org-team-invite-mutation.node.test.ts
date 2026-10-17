import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { teamInviteMutationOptions } from './pages/org-team-invite-mutation.ts'

test.each([false, true])(
	'team invite reconciliation retains the submitted actor and org, lost response: %s',
	async (lost) => {
		const client = new QueryClient()
		const key = ['page', 'actor-a', 'loadOrgTeams', { slug: 'org-a' }]
		const otherOrg = ['page', 'actor-a', 'loadOrgTeams', { slug: 'org-b' }]
		const otherActor = ['page', 'actor-b', 'loadOrgTeams', { slug: 'org-a' }]
		for (const entry of [key, otherOrg, otherActor])
			client.setQueryData(entry, { teams: [] })
		const observer = new MutationObserver(
			client,
			teamInviteMutationOptions(client, key, async (_input: string) => {
				if (lost) throw new Error('Response lost')
			}),
		)
		await observer.mutate('link-1').catch(() => undefined)
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryState(otherOrg)?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
		client.clear()
	},
)
