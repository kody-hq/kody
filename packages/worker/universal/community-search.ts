import {
	parseCommunityListingCategory,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import { routes } from '#universal/routes.ts'

export const communityListingSorts = ['best', 'newest'] as const

export type CommunityListingSort = (typeof communityListingSorts)[number]

export const defaultCommunityListingSort = 'best' satisfies CommunityListingSort

export function parseCommunityListingSort(
	raw: string | null | undefined,
): CommunityListingSort {
	return raw === 'newest' ? 'newest' : defaultCommunityListingSort
}

export function readCommunitySearchFromHref(href: string) {
	const url = new URL(href, 'http://localhost')
	return {
		query: url.searchParams.get('q') ?? '',
		sort: parseCommunityListingSort(url.searchParams.get('sort')),
		category: parseCommunityListingCategory(url.searchParams.get('category')),
	}
}

/** Keeps the picked install org (`?org=`) on a site-relative href. */
export function withInstallOrg(href: string, installOrg?: string | null) {
	if (!installOrg) return href
	const url = new URL(href, 'http://localhost')
	url.searchParams.set('org', installOrg)
	return `${url.pathname}${url.search}${url.hash}`
}

export function buildCommunityIndexHref(input?: {
	query?: string | null
	sort?: CommunityListingSort
	category?: CommunityListingCategory | null
	/** Org the install badges and Fork target follow (`?org=`). */
	installOrg?: string | null
}) {
	const searchParams = new URLSearchParams()
	const query = input?.query?.trim() ?? ''
	if (query.length > 0) searchParams.set('q', query)
	if (input?.sort === 'newest') searchParams.set('sort', 'newest')
	if (input?.category) searchParams.set('category', input.category)
	if (input?.installOrg) searchParams.set('org', input.installOrg)
	return routes.community.href(
		null,
		searchParams.size > 0 ? { searchParams } : undefined,
	)
}
