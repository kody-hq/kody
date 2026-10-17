import { limitOverrideKeys } from '#universal/plans.ts'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import {
	adminDestinationMutationOptions,
	adminOrgLimitMutationOptions,
	adminOrgLimitsQuery,
} from './admin-user-controls-query.ts'

import { type AdminOrgLimits } from '#universal/loader-data.ts'
function limits(orgId: string): AdminOrgLimits {
	return {
		org: { id: orgId, slug: orgId, displayName: null },
		plan: 'free',
		creditWallet: 'none',
		seats: 1,
		limits: [],
	}
}
const { limitsRpc, userRpc } = vi.hoisted(() => ({
	limitsRpc: vi.fn(),
	userRpc: vi.fn(),
}))
vi.mock('#start/server/admin-controls', () => ({
	readAdminOrgLimits: vi.fn(),
	updateAdminOrgLimits: limitsRpc,
}))
vi.mock('#start/server/admin-mutations', () => ({
	verifyAdminUserEmailDestination: userRpc,
}))
afterEach(() => {
	limitsRpc.mockReset()
	userRpc.mockReset()
})
test('late limit response reconciles only the submitted actor and org after unmount', async () => {
	const client = new QueryClient()
	const first = adminOrgLimitsQuery('actor-a', 'org-a').queryKey
	const other = adminOrgLimitsQuery('actor-a', 'org-b').queryKey
	const otherActor = adminOrgLimitsQuery('actor-b', 'org-a').queryKey
	for (const key of [first, other, otherActor])
		client.setQueryData(key, limits(key[2]))
	let release!: (response: AdminOrgLimits & { ok: true }) => void
	limitsRpc.mockImplementation(
		() =>
			new Promise<AdminOrgLimits & { ok: true }>((resolve) => {
				release = resolve
			}),
	)
	const observer = new MutationObserver(
		client,
		adminOrgLimitMutationOptions(client),
	)
	const unsubscribe = observer.subscribe(() => {})
	const write = observer.mutate({
		actorKey: 'actor-a',
		orgId: 'org-a',
		change: { key: limitOverrideKeys[0], value: 'unlimited', expiresAt: null },
		reason: 'Approved exception',
	})
	await vi.waitFor(() => expect(limitsRpc).toHaveBeenCalledOnce())
	unsubscribe()
	release({ ok: true, ...limits('org-a'), seats: 2 })
	await write
	expect(client.getQueryData(first)).toMatchObject({
		org: { id: 'org-a' },
		seats: 2,
	})
	expect(client.getQueryData(other)).toEqual(limits('org-b'))
	expect(client.getQueryData(otherActor)).toEqual(limits('org-a'))
	expect(limitsRpc.mock.calls[0]![0].data).toMatchObject({
		orgId: 'org-a',
		reason: 'Approved exception',
		changes: [{ value: 'unlimited' }],
	})
	client.clear()
})
test('lost limit response invalidates authoritative data without inventing success', async () => {
	const client = new QueryClient()
	const key = adminOrgLimitsQuery('actor-a', 'org-a').queryKey
	client.setQueryData(key, limits(key[2]))
	limitsRpc.mockRejectedValue(new Error('Lost response'))
	const observer = new MutationObserver(
		client,
		adminOrgLimitMutationOptions(client),
	)
	await expect(
		observer.mutate({
			actorKey: 'actor-a',
			orgId: 'org-a',
			change: { key: limitOverrideKeys[0], value: null, expiresAt: null },
			reason: 'Remove exception',
		}),
	).rejects.toThrow('Lost response')
	expect(client.getQueryData(key)).toEqual(limits('org-a'))
	expect(client.getQueryState(key)?.isInvalidated).toBe(true)
	client.clear()
})
test('destination verification submits the captured user and invalidates only its actor', async () => {
	const client = new QueryClient()
	const first = ['admin-users-pages', 'actor-a', 'search']
	const other = ['admin-users-pages', 'actor-b', 'search']
	client.setQueryData(first, { old: true })
	client.setQueryData(other, { old: true })
	userRpc.mockResolvedValue({ ok: true })
	const observer = new MutationObserver(
		client,
		adminDestinationMutationOptions(client),
	)
	await observer.mutate({
		actorKey: 'actor-a',
		stableUserId: 'user-a',
		destinationEmail: 'extra@example.com',
	})
	expect(userRpc.mock.calls[0]![0].data).toEqual({
		stableUserId: 'user-a',
		destinationEmail: 'extra@example.com',
	})
	expect(client.getQueryState(first)?.isInvalidated).toBe(true)
	expect(client.getQueryState(other)?.isInvalidated).toBe(false)
	client.clear()
})
