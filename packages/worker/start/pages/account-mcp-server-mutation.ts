import { type QueryClient } from '@tanstack/react-query'
import { invalidatePageResources } from '../page-invalidation-cache.ts'

export function mcpServerMutationOptions<TInput, TResult>(
	client: QueryClient,
	scope: { actorKey: string | null; orgSlug: string | null },
	send: (input: TInput) => Promise<TResult>,
) {
	return {
		gcTime: 0,
		retry: false,
		mutationFn: send,
		onMutate: () => ({ ...scope }),
		onSettled: (
			_data: unknown,
			_error: unknown,
			_input: TInput,
			submitted: typeof scope | undefined,
		) =>
			submitted
				? invalidatePageResources(
						client,
						submitted.actorKey,
						[
							'loadMcpServersPage',
							'loadOnboarding',
							'loadAccountPage',
							'loadUsagePage',
						],
						'active',
						{ orgSlug: submitted.orgSlug },
					)
				: undefined,
	}
}
