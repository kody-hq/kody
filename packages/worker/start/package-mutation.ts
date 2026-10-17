import {
	useMutation,
	useQueryClient,
	useMutationState,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { packageMutationOptions } from './package-mutation-cache.ts'

export function usePackageMutation<
	TInput extends { packageId: string },
	TResult extends { ok: boolean; error?: string; approvalUrl?: string },
>(
	packageId: string,
	send: (input: { data: TInput }) => Promise<TResult>,
	operation: string,
	reconciliation: 'package' | 'related' | 'deleted' = 'related',
) {
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const pending = useMutationState({
		filters: {
			mutationKey: ['package', actorKey, packageId],
			status: 'pending',
		},
		select: (mutation) => ({
			operation: mutation.options.meta?.operation,
			submittedAt: mutation.state.submittedAt,
		}),
	})
	const mutation = useMutation({
		...packageMutationOptions(client, actorKey, send, reconciliation),
		mutationKey: ['package', actorKey, packageId],
		meta: { operation },
	})
	return {
		...mutation,
		pendingAction: pending.at(-1)?.operation,
		pendingLockedAt: pending.length
			? new Date(pending.at(-1)!.submittedAt).toISOString()
			: null,
		submit: mutation.mutateAsync,
	}
}
