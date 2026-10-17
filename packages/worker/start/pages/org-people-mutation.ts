import {
	mutationOptions,
	useMutation,
	useQueryClient,
	type QueryClient,
	type QueryKey,
} from '@tanstack/react-query'

/** Each operation stays typed; reconciliation belongs to its submitted scope. */
export function useOrgPeopleMutation<TInput, TResult>(
	queryKey: QueryKey,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return useMutation(orgPeopleMutationOptions(useQueryClient(), queryKey, send))
}
export function orgPeopleMutationOptions<TInput, TResult>(
	client: QueryClient,
	queryKey: QueryKey,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return mutationOptions({
		mutationFn: (data: TInput) => send({ data }),
		onMutate: () => ({ queryKey }),
		gcTime: 0,
		onSettled: async (_result, _error, _variables, submission) => {
			if (!submission) return
			const queryKey = submission.queryKey
			const submittedInput = queryKey[3]
			if (
				!submittedInput ||
				typeof submittedInput !== 'object' ||
				!('slug' in submittedInput)
			)
				return
			const slug = submittedInput.slug
			const filters = {
				predicate: (query: { queryKey: QueryKey }) => {
					const [kind, actor, resource, input] = query.queryKey
					if (actor !== queryKey[1]) return false
					// Membership controls the account menu and organization chooser too.
					if (kind === 'shell') return true
					if (kind !== 'page') return false
					if (resource === 'loadOrganizations') return true

					return (
						input !== null &&
						typeof input === 'object' &&
						(('orgSlug' in input && input.orgSlug === slug) ||
							('slug' in input && input.slug === slug) ||
							('username' in input && input.username === slug))
					)
				},
			}
			// A lost response can follow an accepted membership or permission write.
			// Cancel earlier reads so they cannot restore pre-write data afterward.
			await client.cancelQueries(filters)
			await client.invalidateQueries(filters)
		},
	})
}
