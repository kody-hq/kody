import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'
import { type PackageCollaboratorsChange } from '#universal/package-collaborators.ts'

export function collaboratorsMutationKey(
	actorKey: string | null,
	page: { username: string; kodyId: string },
) {
	return ['packageCollaborators', actorKey, page.username, page.kodyId] as const
}

export type CollaboratorsMutationInput = {
	key: string
	change: PackageCollaboratorsChange
}

export function collaboratorsMutationOptions<TResult>(
	client: QueryClient,
	actorKey: string | null,
	page: { username: string; kodyId: string },
	send: (input: CollaboratorsMutationInput) => Promise<TResult>,
) {
	return mutationOptions({
		mutationKey: collaboratorsMutationKey(actorKey, page),
		retry: false,
		gcTime: 0,
		mutationFn: send,
		onSettled: async (_data, _error, input) => {
			const invite =
				input.change.intent === 'invite' ||
				input.change.intent === 'revoke-invite'
			const inviteKey = [
				'page',
				actorKey,
				'loadPackageCollaborators',
				page,
			] as const
			// Permission changes can affect any resource for this actor. Reads
			// remain independent of writes, including a first navigation read.
			await Promise.allSettled(
				client
					.getQueryCache()
					.findAll({
						...(invite ? { queryKey: inviteKey, exact: true } : {}),
						predicate: (query) =>
							query.meta?.actorKey === actorKey &&
							query.state.data === undefined &&
							query.state.fetchStatus === 'fetching',
					})
					.map((query) => query.promise),
			)
			if (invite) {
				// Pending invitations do not change access. Confirm only the
				// submitted package, including a response lost after a committed write.
				await client.cancelQueries({
					queryKey: inviteKey,
					exact: true,
					predicate: (query) => query.state.data !== undefined,
				})
				await client.invalidateQueries({
					queryKey: inviteKey,
					exact: true,
					refetchType: 'all',
				})
				return
			}
			// A lost response can still represent a committed permission change.
			// Confirm inactive pages too before dropping the pending UI state.
			await invalidatePageResources(client, actorKey, 'permissions', 'all')
		},
	})
}
