import { routes } from '#universal/routes.ts'

export const packageAppConnectedPeoplePageSize = 25
export const packageAppConnectedPeopleMaxPageSize = 100

/** One person signed in to the package app with Kody, as its owner sees them. */
export type PackageAppConnectedPersonView = {
	grantId: string
	username: string | null
	displayName: string | null
	avatarUrl: string | null
	/** Their public profile, or null when it is private. */
	profileHref: string | null
	connectedAt: string
	lastUsedAt: string | null
	/** What they approved, in the consent screen's plain language. */
	allows: Array<string>
}

export type PackageAppConnectedPeopleView = {
	ok: true
	package: { id: string; kodyId: string; name: string }
	people: Array<PackageAppConnectedPersonView>
	total: number
	page: number
	pageSize: number
}

/** The package chrome for the tab, from the package detail API. */
type PackageAppConnectedPeoplePageShell = {
	username: string
	kodyId: string
	name: string
	description: string
	isPrivate: boolean
	isListed: boolean
	listingId: string | null
	defaultBranch: string | null
	publishedCommit: string | null
	ownerProfilePublic: boolean
	viewerIsOwner: boolean
	viewerCanManage: boolean
	viewerCanManageAccess: boolean
}

export type PackageAppConnectedPeopleLoaderData =
	| {
			ok: true
			shell: PackageAppConnectedPeoplePageShell
			view: PackageAppConnectedPeopleView
	  }
	| { ok: false; notFound: true }

export function packageAppConnectedPeopleHref(input: {
	username: string
	kodyId: string
	page?: number
}) {
	const href = routes.communityPackageConnectedPeople.href(input)
	return input.page && input.page > 1 ? `${href}?page=${input.page}` : href
}

export function packageAppConnectedPeoplePageCount(view: {
	total: number
	pageSize: number
}) {
	return Math.max(1, Math.ceil(view.total / view.pageSize))
}

export function packageAppConnectedPersonName(person: {
	username: string | null
	displayName: string | null
}) {
	return (
		person.displayName?.trim() ||
		(person.username ? `@${person.username}` : 'Kody user')
	)
}
