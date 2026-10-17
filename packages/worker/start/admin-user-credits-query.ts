import {
	grantAdminCredits,
	readAdminCreditWallet,
} from '#start/server/admin-controls'
import {
	mutationOptions,
	queryOptions,
	type QueryClient,
} from '@tanstack/react-query'

export function adminCreditWalletQuery(
	actorKey: string | null,
	stableUserId: string,
) {
	return queryOptions({
		meta: { actorKey },
		queryKey: ['admin-user', actorKey, stableUserId, 'credits'] as const,
		queryFn: ({ signal }) =>
			readAdminCreditWallet({ data: { stableUserId }, signal }),
	})
}
export function adminCreditGrantOptions(
	client: QueryClient,
	reconcile: () => Promise<void>,
) {
	return mutationOptions({
		mutationFn: async (input: {
			actorKey: string | null
			stableUserId: string
			amountCents: number
			note?: string
		}) =>
			grantAdminCredits({
				data: {
					stableUserId: input.stableUserId,
					amountCents: input.amountCents,
					note: input.note,
				},
			}),
		onMutate: () => reconcile,
		onSuccess: async (payload, input) => {
			const queryKey = adminCreditWalletQuery(
				input.actorKey,
				input.stableUserId,
			).queryKey
			await client.cancelQueries({ queryKey, exact: true })
			client.setQueryData(queryKey, payload)
		},
		onSettled: async (_data, _error, input, submittedReconcile) => {
			await Promise.all([
				client.invalidateQueries({
					queryKey: ['admin-user', input.actorKey, input.stableUserId],
				}),
				submittedReconcile?.(),
			])
		},
		gcTime: 0,
	})
}
