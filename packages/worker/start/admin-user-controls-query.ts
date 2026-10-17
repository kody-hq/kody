import {
	readAdminOrgLimits,
	updateAdminOrgLimits,
} from '#start/server/admin-controls'
import { verifyAdminUserEmailDestination } from '#start/server/admin-mutations'
import {
	type LimitOverrideKey,
	type LimitOverrideValue,
} from '#universal/plans.ts'
import {
	mutationOptions,
	queryOptions,
	type QueryClient,
} from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'

export function adminOrgLimitsQuery(actorKey: string | null, orgId: string) {
	return queryOptions({
		meta: { actorKey },
		queryKey: ['admin-org', actorKey, orgId, 'limits'] as const,
		queryFn: ({ signal }) => readAdminOrgLimits({ data: { orgId }, signal }),
	})
}
export type LimitChange = {
	key: LimitOverrideKey
	value: LimitOverrideValue | null
	expiresAt: string | null
}
export function adminOrgLimitMutationOptions(client: QueryClient) {
	return mutationOptions({
		retry: false,
		gcTime: 0,
		mutationFn: async (input: {
			actorKey: string | null
			orgId: string
			change: LimitChange
			reason: string
		}) =>
			updateAdminOrgLimits({
				data: {
					orgId: input.orgId,
					changes: [input.change],
					reason: input.reason,
				},
			}),
		onSuccess: async (data, input) => {
			const queryKey = adminOrgLimitsQuery(input.actorKey, input.orgId).queryKey
			await client.cancelQueries({ queryKey, exact: true })
			client.setQueryData(queryKey, data)
		},
		onSettled: async (_data, _error, input) => {
			await Promise.all([
				client.invalidateQueries({
					queryKey: adminOrgLimitsQuery(input.actorKey, input.orgId).queryKey,
					exact: true,
				}),
				invalidatePageResources(client, input.actorKey, [
					'loadAdminUsers',
					'loadAdminInsights',
				]),
			])
		},
	})
}
export function adminDestinationMutationOptions(client: QueryClient) {
	return mutationOptions({
		retry: false,
		gcTime: 0,
		mutationFn: async (input: {
			actorKey: string | null
			stableUserId: string
			destinationEmail: string
		}) =>
			verifyAdminUserEmailDestination({
				data: {
					stableUserId: input.stableUserId,
					destinationEmail: input.destinationEmail,
				},
			}),
		onSettled: async (_data, _error, input) => {
			await Promise.all([
				invalidatePageResources(client, input.actorKey, ['loadAdminUsers']),
				client.invalidateQueries({
					queryKey: ['admin-users-pages', input.actorKey],
				}),
				client.invalidateQueries({
					queryKey: ['admin-user', input.actorKey, input.stableUserId],
				}),
			])
		},
	})
}
