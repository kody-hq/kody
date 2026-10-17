import { createPageQuery } from './page-query.ts'
import { loadCredentialsPage } from '#start/server/credentials'
import { isCredentialKind } from '#universal/credential-contracts.ts'
import { searchText } from './filter-search.ts'

export const credentialPresentationSearchKeys = [
	'q',
	'kind',
	'scope',
	'packageScoped',
	'locked',
] as const

/** Keep presentation state typed and outside the authorized resource identity. */
export function validateCredentialSearch(search: Record<string, unknown>) {
	const kinds = Array.isArray(search.kind) ? search.kind : [search.kind]
	return {
		q: searchText(search.q),
		kind: Array.isArray(search.kind)
			? kinds.filter(isCredentialKind)
			: isCredentialKind(search.kind)
				? search.kind
				: undefined,
		scope:
			search.scope === 'org' || search.scope === 'personal'
				? search.scope
				: undefined,
		packageScoped:
			search.packageScoped === true || search.packageScoped === 'true'
				? true
				: search.packageScoped === false || search.packageScoped === 'false'
					? false
					: undefined,
		locked:
			typeof search.locked === 'string' || typeof search.locked === 'boolean'
				? search.locked
				: undefined,
	}
}

// Detail visibility depends on the current authorized list. Keep that aggregate
// in one request until list access can be refreshed independently. Splitting it
// now would repeat the list read in a second RPC, without safe cache reuse.
const pageQuery = createPageQuery('loadCredentialsPage', loadCredentialsPage, {
	freshAuthorization: true,
})

/** Filters do not identify server data. Organization and selection still do. */
export function credentialsPageQuery(
	actorKey: string | null,
	input: { orgSlug: string; credentialId?: string },
) {
	return pageQuery(actorKey, input)
}
