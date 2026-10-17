import { type Query } from '@tanstack/react-query'

export function pageResourceKey(actorKey: string | null, resource: string) {
	return ['page', actorKey, resource] as const
}

export type PageOrgScope = { orgSlug: string | null }
/** Actor identity is shared across orgs, resource payloads are not. */
export function scopedPageResource(
	actorKey: string | null,
	resource: string,
	scope: PageOrgScope,
) {
	return {
		queryKey: pageResourceKey(actorKey, resource),
		predicate: (query: Query) =>
			pageQueryInputOrg(query.queryKey[3]) === scope.orgSlug,
	}
}
/** Native collection identity or package owner identity, never a presentation URL. */
export function pageQueryInputOrg(value: unknown): string | null {
	if (value && typeof value === 'object') {
		if ('orgSlug' in value && typeof value.orgSlug === 'string')
			return value.orgSlug
		if ('username' in value && typeof value.username === 'string')
			return value.username
	}
	return null
}
