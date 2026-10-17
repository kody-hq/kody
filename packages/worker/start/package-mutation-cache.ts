import {
	mutationOptions,
	type QueryClient,
	type Query,
} from '@tanstack/react-query'
import { type loadPackage } from '#start/server/public-data'
import { invalidatePageResources } from './page-invalidation-cache.ts'

type PackagePage = Awaited<ReturnType<typeof loadPackage>>
type PackageOutcome = { ok: boolean; error?: string; approvalUrl?: string }
export function packageMutationOptions<
	TInput extends { packageId: string },
	TResult extends PackageOutcome,
>(
	client: QueryClient,
	actorKey: string | null,
	send: (input: { data: TInput }) => Promise<TResult>,
	reconciliation: 'package' | 'related' | 'deleted' = 'related',
) {
	return mutationOptions({
		retry: false,
		gcTime: 0,
		mutationFn: async (data: TInput) => {
			const result = await send({ data })
			if (!result.ok)
				throw Object.assign(
					new Error(result.error || 'Unable to update this package.'),
					{ approvalUrl: result.approvalUrl },
				)
			return result
		},
		onMutate: (data: TInput) => ({
			actorKey,
			packageId: data.packageId,
			reconciliation,
		}),
		onSettled: async (_result, _error, _data, scope) => {
			if (!scope) return
			if (scope.reconciliation === 'package') {
				const filters = {
					queryKey: ['page', scope.actorKey, 'loadPackage'],
					predicate: (query: Query) => {
						const page = query.state.data as PackagePage | undefined
						return (
							page?.kind === 'page' &&
							page.data.ownerPackage?.id === scope.packageId
						)
					},
				}
				await client.cancelQueries(filters)
				await client.invalidateQueries(filters)
				return
			}
			await invalidatePageResources(
				client,
				scope.actorKey,
				['loadPackage', 'loadPackageFiles', 'loadProfile', 'loadCommunity'],
				scope.reconciliation === 'deleted' ? 'none' : 'active',
			)
		},
	})
}
