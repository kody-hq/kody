import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { loadOrgFollows, loadPackageFollow } from '#start/server/follows'
import { invalidatePageResources } from './page-invalidation-cache.ts'

export const followsKeys = {
	org: (actor: string | null, orgSlug: string) =>
		['follows', actor, 'org', orgSlug] as const,
	targets: (actor: string | null) => ['follows', actor, 'target'] as const,
	target: (
		actor: string | null,
		target: { username: string; kodyId: string; kind?: 'package' | 'repo' },
	) => ['follows', actor, 'target', target] as const,
}
export function orgFollowsQuery(actor: string | null, orgSlug: string) {
	return queryOptions({
		queryKey: followsKeys.org(actor, orgSlug),
		queryFn: ({ signal }) => loadOrgFollows({ data: { orgSlug }, signal }),
		staleTime: 30_000,
		meta: { actorKey: actor },
	})
}
export function packageFollowQuery(
	actor: string | null,
	target: { username: string; kodyId: string; kind?: 'package' | 'repo' },
) {
	return queryOptions({
		queryKey: followsKeys.target(actor, target),
		queryFn: ({ signal }) => loadPackageFollow({ data: target, signal }),
		staleTime: 30_000,
		meta: { actorKey: actor },
	})
}

export function followMutationOptions<
	TInput extends { orgSlug: string },
	TResult,
>(
	client: QueryClient,
	actor: string | null,
	send: (input: TInput) => Promise<TResult>,
) {
	return {
		mutationKey: ['follows', actor, 'write'] as const,
		mutationFn: send,
		retry: false,
		onMutate: (input: TInput) => ({ actor, orgSlug: input.orgSlug }),
		onSettled: async (
			_data: unknown,
			_error: unknown,
			_input: TInput,
			scope: { actor: string | null; orgSlug: string } | undefined,
		) => {
			if (!scope) return
			const keys = [
				followsKeys.org(scope.actor, scope.orgSlug),
				followsKeys.targets(scope.actor),
			]
			const unfinished = keys
				.flatMap((queryKey) => client.getQueryCache().findAll({ queryKey }))
				.filter(
					(query) =>
						query.state.data === undefined &&
						query.state.fetchStatus === 'fetching',
				)
			await Promise.allSettled(unfinished.map((query) => query.promise))
			// Confirm inactive reads too: navigation may have completed while the
			// write was pending, before this settlement callback captured queries.
			await Promise.all([
				...keys.map((queryKey) =>
					client.invalidateQueries({ queryKey, refetchType: 'all' }),
				),
				invalidatePageResources(client, scope.actor, ['loadPackage']),
			])
		},
	}
}
