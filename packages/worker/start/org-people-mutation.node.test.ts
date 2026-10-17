import { afterEach, expect, test, vi } from 'vitest'
import {
	MutationObserver,
	QueryObserver,
	QueryClient,
} from '@tanstack/react-query'
import { removeOrganizationMember } from '#start/server/org-mutations'
vi.mock('#start/server/org-mutations', () => ({
	removeOrganizationMember: vi.fn(),
}))
import { orgPeopleMutationOptions } from './pages/org-people-mutation.ts'

afterEach(() => vi.clearAllMocks())

test.each(['accepted', 'lost response'])(
	'organization people writes reconcile their captured scope after unmount: %s',
	async (outcome) => {
		const client = new QueryClient()
		const key = ['page', 'actor-a', 'loadOrgMembers', { slug: 'team-a' }]
		const teamKey = ['page', 'actor-a', 'loadOrgTeams', { slug: 'team-a' }]
		const otherOrg = ['page', 'actor-a', 'loadOrgMembers', { slug: 'team-b' }]
		const otherActor = ['page', 'actor-b', 'loadOrgMembers', { slug: 'team-a' }]
		const affected = [
			key,
			teamKey,
			[
				'page',
				'actor-a',
				'loadJobsPage',
				{ orgSlug: 'team-a', jobId: 'job-one' },
			],
			[
				'page',
				'actor-a',
				'loadPackage',
				{ username: 'team-a', kodyId: 'example' },
			],
			['page', 'actor-a', 'loadJobsPage', { orgSlug: 'team-a' }],
			['shell', 'actor-a', ''],
			['page', 'actor-a', 'loadOrganizations', undefined],
		]
		const unaffected = [
			otherOrg,
			otherActor,
			[
				'page',
				'actor-a',
				'loadJobsPage',
				{ orgSlug: 'team-b', jobId: 'job-one' },
			],
			['page', 'actor-a', 'loadJobsPage', { orgSlug: 'team-b' }],
			['shell', 'actor-b', ''],
		]
		for (const entry of [...affected, ...unaffected])
			client.setQueryData(entry, { members: ['previous-member'] })
		let resolve!: (
			response: Awaited<ReturnType<typeof removeOrganizationMember>>,
		) => void
		let reject!: (error: Error) => void
		vi.mocked(removeOrganizationMember).mockImplementationOnce(
			() =>
				new Promise((yes, no) => {
					resolve = yes
					reject = no
				}),
		)
		const observer = new MutationObserver(
			client,
			orgPeopleMutationOptions(client, key, removeOrganizationMember),
		)
		const unsubscribe = observer.subscribe(() => {})
		const write = observer.mutate({
			orgSlug: 'team-a',
			userId: 'previous-member',
		})
		await vi.waitFor(() =>
			expect(removeOrganizationMember).toHaveBeenCalledOnce(),
		)
		unsubscribe()
		if (outcome === 'accepted') {
			resolve({ ok: true })
			await write
		} else {
			reject(new Error('Response lost after write'))
			await expect(write).rejects.toThrow('Response lost after write')
		}
		for (const entry of affected)
			expect(client.getQueryState(entry)?.isInvalidated).toBe(true)
		for (const entry of unaffected)
			expect(client.getQueryState(entry)?.isInvalidated).toBe(false)
		client.clear()
	},
)

test('accepted one-time invitation results survive a failed confirmation read', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = ['page', 'actor-a', 'loadOrgMembers', { slug: 'team-a' }]
	client.setQueryData(key, { members: [] })
	const read = vi.fn(async () => {
		throw new Error('Read temporarily unavailable')
	})
	const page = new QueryObserver(client, {
		queryKey: key,
		queryFn: read,
		staleTime: Infinity,
	})
	const unsubscribe = page.subscribe(() => {})
	const accepted = {
		ok: true,
		inviteLink: {
			url: 'https://kody.test/join/token',
			token: 'token',
			expiresAt: '2026-11-01',
		},
	}
	const send = vi.fn(async (_input: { data: { orgSlug: string } }) => accepted)
	const mutation = new MutationObserver(
		client,
		orgPeopleMutationOptions(client, key, send),
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
