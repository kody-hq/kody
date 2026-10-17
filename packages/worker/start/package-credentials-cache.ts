/** Match only the actor and package that received a credential or trigger write. */
export function packageCredentialsQueryFilter(input: {
	actorKey: string | null
	username: string
	kodyId: string
}) {
	return {
		queryKey: ['page', input.actorKey, 'loadPackageCredentialsPage'],
		predicate: (query: { queryKey: readonly unknown[] }) => {
			const page = query.queryKey[3]
			return (
				typeof page === 'object' &&
				page !== null &&
				'orgSlug' in page &&
				page.orgSlug === input.username &&
				'kodyId' in page &&
				page.kodyId === input.kodyId
			)
		},
	}
}
