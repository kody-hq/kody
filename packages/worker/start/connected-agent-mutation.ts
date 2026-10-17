import { revokeConnectedAgent } from '#start/server/account-mutations'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import { updateOrgPagePayload } from './org-page-cache.ts'
import { settleConnectionResources } from './connection-resource-settlement.ts'

export type ConnectedAgentRevoke = {
	clientId: string
	orgSlug: string | null
	actorKey: string | null
}
export function connectedAgentMutationOptions(queryClient: QueryClient) {
	return mutationOptions({
		gcTime: 0,
		mutationFn: async ({ clientId, orgSlug }: ConnectedAgentRevoke) => {
			await revokeConnectedAgent({
				data: { orgSlug: orgSlug ?? undefined, clientId },
			})
		},
		onSuccess: (_data, { actorKey, clientId, orgSlug }) => {
			updateOrgPagePayload<AccountConnectedAgentsLoaderData>(
				queryClient,
				actorKey,
				'loadConnectionsPage',
				{ orgSlug },
				(payload) => ({
					...payload,
					agents: payload.agents.filter((agent) => agent.clientId !== clientId),
				}),
			)
		},
		onSettled: (_data, _error, { actorKey, orgSlug }) =>
			settleConnectionResources(queryClient, actorKey, orgSlug, [
				'loadConnectionsPage',
				'loadConnectionUsagePage',
			]),
	})
}
