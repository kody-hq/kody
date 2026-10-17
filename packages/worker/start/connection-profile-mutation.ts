import { type QueryClient } from '@tanstack/react-query'
import { settleConnectionResources } from './connection-resource-settlement.ts'

export function connectionProfileMutationOptions(
	client: QueryClient,
	actorKey: string | null,
	orgSlug: string | null,
) {
	return {
		mutationKey: ['connectionProfiles', actorKey, orgSlug],
		gcTime: 0,
		onMutate: () => ({ actorKey, orgSlug }),
		onSettled: (
			_data: unknown,
			_error: unknown,
			_input: unknown,
			scope: { actorKey: string | null; orgSlug: string | null } | undefined,
		) => {
			if (!scope) return
			return settleConnectionResources(client, scope.actorKey, scope.orgSlug, [
				'loadConnectionsPage',
				'loadConnectionUsagePage',
			])
		},
	}
}
