import { routes } from '#universal/routes.ts'

/** One fork row on `/@owner/kody-id/forks`, already filtered for the viewer. */
export type PackageForkView = {
	id: string
	name: string
	href: string
	description: string
	/** Private or hidden: shown only because this viewer can read it. */
	isPrivate: boolean
	createdAt: string
	ownerSlug: string
	ownerDisplayName: string | null
	ownerAvatarUrl: string | null
	iconUrl: string | null
}

type PackageForksShell = {
	username: string
	kodyId: string
	name: string
	description: string
	isPrivate: boolean
	isListed: boolean
	listingId: string | null
	listingIconUrl: string | null
	defaultBranch: string | null
	publishedCommit: string | null
	ownerProfilePublic: boolean
	viewerIsOwner: boolean
	viewerCanManage: boolean
	viewerCanManageAccess: boolean
	viewerCanSeeConnectedPeople: boolean
}

export type PackageForksLoaderData = {
	ok: true
	shell: PackageForksShell
	forks: Array<PackageForkView>
	/** Forks this viewer may see; can exceed `forks.length` past the page cap. */
	total: number
}

export function packageForksHref(input: { username: string; kodyId: string }) {
	return routes.communityPackageForks.href(input)
}
