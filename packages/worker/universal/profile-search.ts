import { routes } from '#universal/routes.ts'
import {
	type ProfilePackageAppFilter,
	type ProfilePackageFilters,
	type ProfilePackageHiddenFilter,
	type ProfilePackageListingFilter,
	type ProfilePackagePresenceFilter,
	type ProfilePackageSort,
	type ProfilePackageSortDirection,
	type ProfilePackageVisibilityFilter,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'
import { isProfilePathname } from '#universal/profile-path.ts'

const defaultProfilePackageFilters = {
	query: '',
	visibility: 'all',
	listing: 'all',
	hidden: 'all',
	app: 'all',
	package: 'all',
	sort: 'updated',
	dir: 'desc',
} as const satisfies ProfilePackageFilters

const profilePackageClientFilterParams = [
	'q',
	'visibility',
	'listing',
	'hidden',
	'app',
	'package',
	'sort',
	'dir',
] as const

function parseVisibility(
	raw: string | null | undefined,
): ProfilePackageVisibilityFilter {
	return raw === 'public' || raw === 'private' ? raw : 'all'
}

function parseListing(
	raw: string | null | undefined,
): ProfilePackageListingFilter {
	return raw === 'published' || raw === 'unpublished' || raw === 'ahead'
		? raw
		: 'all'
}

function parseHidden(
	raw: string | null | undefined,
): ProfilePackageHiddenFilter {
	return raw === 'yes' || raw === 'no' ? raw : 'all'
}

function parseApp(raw: string | null | undefined): ProfilePackageAppFilter {
	return raw === 'yes' || raw === 'no' ? raw : 'all'
}

function parsePackagePresence(
	raw: string | null | undefined,
): ProfilePackagePresenceFilter {
	return raw === 'yes' || raw === 'no' ? raw : 'all'
}

function parseSort(raw: string | null | undefined): ProfilePackageSort {
	return raw === 'name' || raw === 'created'
		? raw
		: defaultProfilePackageFilters.sort
}

function parseDir(
	raw: string | null | undefined,
): ProfilePackageSortDirection | null {
	return raw === 'asc' || raw === 'desc' ? raw : null
}

export function defaultProfilePackageSortDirection(
	sort: ProfilePackageSort,
): ProfilePackageSortDirection {
	switch (sort) {
		case 'name':
			return 'asc'
		case 'updated':
		case 'created':
			return 'desc'
		default: {
			const exhaustive: never = sort
			throw new Error(`Unhandled profile package sort: ${exhaustive}`)
		}
	}
}

function readProfilePackageFiltersFromUrl(
	url: URL,
	options?: { allowOwnerFilters?: boolean },
): ProfilePackageFilters {
	const allowOwnerFilters = options?.allowOwnerFilters === true
	const listing = parseListing(url.searchParams.get('listing'))
	const sort = parseSort(url.searchParams.get('sort'))
	return {
		query: url.searchParams.get('q')?.trim() ?? '',
		visibility: allowOwnerFilters
			? parseVisibility(url.searchParams.get('visibility'))
			: 'all',
		listing:
			allowOwnerFilters || listing !== 'ahead'
				? listing
				: defaultProfilePackageFilters.listing,
		hidden: allowOwnerFilters
			? parseHidden(url.searchParams.get('hidden'))
			: 'all',
		app: parseApp(url.searchParams.get('app')),
		package: parsePackagePresence(url.searchParams.get('package')),
		sort,
		dir:
			parseDir(url.searchParams.get('dir')) ??
			defaultProfilePackageSortDirection(sort),
	}
}

export function readProfilePackageFiltersFromHref(
	href: string,
	options?: { allowOwnerFilters?: boolean },
): ProfilePackageFilters {
	return readProfilePackageFiltersFromUrl(
		new URL(href, 'http://localhost'),
		options,
	)
}

export function profilePackageFiltersAreActive(filters: ProfilePackageFilters) {
	return (
		filters.visibility !== 'all' ||
		filters.listing !== 'all' ||
		filters.hidden !== 'all' ||
		filters.app !== 'all' ||
		filters.package !== 'all'
	)
}

export function profilePackageSortIsActive(filters: {
	sort: ProfilePackageSort
	dir: ProfilePackageSortDirection
}) {
	return (
		filters.sort !== defaultProfilePackageFilters.sort ||
		filters.dir !== defaultProfilePackageSortDirection(filters.sort)
	)
}

export function buildProfileHref(input: {
	username: string
	/** The list's own page when it is not the public profile (`/@slug/-/repositories`). */
	basePath?: string
	query?: string | null
	visibility?: ProfilePackageVisibilityFilter
	listing?: ProfilePackageListingFilter
	hidden?: ProfilePackageHiddenFilter
	app?: ProfilePackageAppFilter
	package?: ProfilePackagePresenceFilter
	sort?: ProfilePackageSort
	dir?: ProfilePackageSortDirection
	extraSearchParams?: URLSearchParams
}) {
	const searchParams = new URLSearchParams()
	const query = input.query?.trim() ?? ''
	if (query.length > 0) searchParams.set('q', query)
	if (input.visibility === 'public' || input.visibility === 'private') {
		searchParams.set('visibility', input.visibility)
	}
	if (
		input.listing === 'published' ||
		input.listing === 'unpublished' ||
		input.listing === 'ahead'
	) {
		searchParams.set('listing', input.listing)
	}
	if (input.hidden === 'yes' || input.hidden === 'no') {
		searchParams.set('hidden', input.hidden)
	}
	if (input.app === 'yes' || input.app === 'no') {
		searchParams.set('app', input.app)
	}
	if (input.package === 'yes' || input.package === 'no') {
		searchParams.set('package', input.package)
	}
	const sort = input.sort ?? defaultProfilePackageFilters.sort
	if (sort !== defaultProfilePackageFilters.sort) {
		searchParams.set('sort', sort)
	}
	const dir = input.dir ?? defaultProfilePackageSortDirection(sort)
	if (dir !== defaultProfilePackageSortDirection(sort)) {
		searchParams.set('dir', dir)
	}
	if (input.extraSearchParams) {
		for (const [key, value] of input.extraSearchParams) {
			if (
				(profilePackageClientFilterParams as ReadonlyArray<string>).includes(
					key,
				)
			) {
				continue
			}
			if (!searchParams.has(key)) searchParams.set(key, value)
		}
	}
	if (input.basePath) {
		return searchParams.size > 0
			? `${input.basePath}?${searchParams.toString()}`
			: input.basePath
	}
	return routes.profile.href(
		{ username: input.username },
		searchParams.size > 0 ? { searchParams } : undefined,
	)
}

function hrefWithoutClientFilterParams(href: string) {
	const url = new URL(href, 'http://localhost')
	const inventoryIsCapped = url.searchParams.has('limit')
	for (const param of profilePackageClientFilterParams) {
		if (param === 'q' && inventoryIsCapped) continue
		url.searchParams.delete(param)
	}
	url.searchParams.sort()
	return `${url.pathname}?${url.searchParams.toString()}${url.hash}`
}

/**
 * True when both URLs are the same `/@username` page and only client-side
 * inventory filters differ: search (`q`) plus chips (`visibility`, `listing`,
 * `hidden`, `app`, `package`, `sort`, `dir`). The already-loaded package list
 * can be re-filtered without a loader or frame fetch.
 *
 * `q` is not client-only when `limit` is present: that inventory is a capped
 * page, so search must reload (server-side `q`) instead of pretending the
 * first page is the full corpus.
 */
export function isProfilePackageFilterOnlyHrefChange(from: string, to: string) {
	const fromUrl = new URL(from, 'http://localhost')
	const toUrl = new URL(to, 'http://localhost')
	if (fromUrl.pathname !== toUrl.pathname) return false
	if (!isProfilePathname(fromUrl.pathname)) return false
	if (fromUrl.search === toUrl.search) return false
	return (
		hrefWithoutClientFilterParams(from) === hrefWithoutClientFilterParams(to)
	)
}

function matchesVisibility(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageVisibilityFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'public':
			return pkg.isPrivate !== true
		case 'private':
			return pkg.isPrivate === true
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile visibility filter: ${exhaustive}`)
		}
	}
}

function matchesHidden(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageHiddenFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'yes':
			return pkg.hidden === true
		case 'no':
			return pkg.hidden !== true
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile hidden filter: ${exhaustive}`)
		}
	}
}

function matchesListing(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageListingFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'published':
			return pkg.communityListingId != null
		case 'unpublished':
			// Plain repos are not unpublished packages.
			return pkg.hasPackage && pkg.communityListingId == null
		case 'ahead':
			return pkg.needsRepublish
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile listing filter: ${exhaustive}`)
		}
	}
}

function matchesApp(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackageAppFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'yes':
			return pkg.hasApp
		case 'no':
			return !pkg.hasApp
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile app filter: ${exhaustive}`)
		}
	}
}

function matchesPackagePresence(
	pkg: PublicProfilePackageItem,
	filter: ProfilePackagePresenceFilter,
) {
	switch (filter) {
		case 'all':
			return true
		case 'yes':
			return pkg.hasPackage
		case 'no':
			return !pkg.hasPackage
		default: {
			const exhaustive: never = filter
			throw new Error(`Unhandled profile package filter: ${exhaustive}`)
		}
	}
}

function profilePackageMatchesFilters(
	pkg: PublicProfilePackageItem,
	filters: ProfilePackageFilters,
) {
	return (
		matchesVisibility(pkg, filters.visibility) &&
		matchesHidden(pkg, filters.hidden) &&
		matchesListing(pkg, filters.listing) &&
		matchesApp(pkg, filters.app) &&
		matchesPackagePresence(pkg, filters.package)
	)
}

function matchesProfilePackageQuery(
	pkg: PublicProfilePackageItem,
	query: string,
) {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return true
	const haystack = [pkg.name, pkg.kodyId, pkg.description, ...pkg.tags]
		.join(' ')
		.toLowerCase()
	return tokens.every((token) => haystack.includes(token))
}

function compareProfilePackages(
	left: PublicProfilePackageItem,
	right: PublicProfilePackageItem,
	sort: ProfilePackageSort,
) {
	switch (sort) {
		case 'name':
			return left.name.localeCompare(right.name)
		case 'updated':
			return left.updatedAt.localeCompare(right.updatedAt)
		case 'created':
			return left.createdAt.localeCompare(right.createdAt)
		default: {
			const exhaustive: never = sort
			throw new Error(`Unhandled profile package sort: ${exhaustive}`)
		}
	}
}

function sortProfilePackages(
	packages: ReadonlyArray<PublicProfilePackageItem>,
	sort: ProfilePackageSort,
	dir: ProfilePackageSortDirection,
) {
	const direction = dir === 'desc' ? -1 : 1
	return [...packages].sort((left, right) => {
		const byField = compareProfilePackages(left, right, sort)
		if (byField !== 0) return byField * direction
		return left.kodyId.localeCompare(right.kodyId)
	})
}

export function filterProfilePackages(
	packages: ReadonlyArray<PublicProfilePackageItem>,
	filters: ProfilePackageFilters,
) {
	const visible = packages.filter(
		(pkg) =>
			(!profilePackageFiltersAreActive(filters) ||
				profilePackageMatchesFilters(pkg, filters)) &&
			matchesProfilePackageQuery(pkg, filters.query),
	)
	return sortProfilePackages(visible, filters.sort, filters.dir)
}
