import { type Query, type QueryClient } from '@tanstack/react-query'
import { type updateAvatar } from '#start/server/account-mutations'
import { type loadAccountPage } from '#start/server/account-page'
import { invalidateShellQueries } from '../shell-query.ts'

type Submission = {
	actorKey: string | null
	href: string
	username: string
	file?: File
}
type AccountData = Awaited<ReturnType<typeof loadAccountPage>>
export function avatarMutationOptions(
	client: QueryClient,
	send: (
		input: Submission,
	) => Promise<Awaited<ReturnType<typeof updateAvatar>>>,
) {
	const accountKey = (input: Submission) =>
		['page', input.actorKey, 'loadAccountPage'] as const
	const matches = (input: Submission) => (query: Query) => {
		if (query.queryKey[0] !== 'page' || query.queryKey[1] !== input.actorKey)
			return false
		if (query.queryKey[2] === 'loadAccountPage') return true
		const queryInput = query.queryKey[3]
		return (
			query.queryKey[2] === 'loadProfile' &&
			!!queryInput &&
			typeof queryInput === 'object' &&
			'username' in queryInput &&
			queryInput.username === input.username
		)
	}
	async function finishFirstReads(input: Submission) {
		const firstReads = client
			.getQueryCache()
			.findAll({ predicate: matches(input) })
			.filter(
				(query) =>
					query.state.data === undefined &&
					query.state.fetchStatus === 'fetching',
			)
			.map((query) => query.promise)
		await Promise.allSettled(firstReads)
	}
	async function confirmAvatar(input: Submission) {
		await finishFirstReads(input)
		await client.cancelQueries({
			predicate: (query) =>
				matches(input)(query) && query.state.data !== undefined,
		})
		await Promise.all([
			client.invalidateQueries({
				predicate: matches(input),
				refetchType: 'all',
			}),
			invalidateShellQueries(client, input.actorKey),
		])
	}

	return {
		mutationFn: send,
		gcTime: 0,
		retry: false,
		onSuccess: async (
			profile: Awaited<ReturnType<typeof updateAvatar>>,
			input: Submission,
		) => {
			await finishFirstReads(input)
			await client.cancelQueries({
				queryKey: accountKey(input),
				predicate: (query) => query.state.data !== undefined,
			})
			client.setQueriesData<AccountData>(
				{ queryKey: accountKey(input) },
				(data) =>
					data
						? {
								...data,
								payloads: {
									...data.payloads,
									accountProfile: {
										...data.payloads.accountProfile,
										avatarUrl: profile.avatarUrl,
									},
								},
							}
						: data,
			)
		},
		onSettled: (_data: unknown, _error: Error | null, input: Submission) =>
			confirmAvatar(input),
	}
}
