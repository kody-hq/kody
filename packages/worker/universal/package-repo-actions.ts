import { type ViewerListingInstall } from './community-public-types.ts'
export type PackageRepoForkAction = {
	/** Null when forking a package the viewer can read that has no listing. */
	listingId: string | null
	/**
	 * Set for a package the viewer can read without a listing (private, or
	 * shared with Read or more). Forks through the package, not a listing.
	 */
	source?: { username: string; kodyId: string } | null
	trusted: boolean
	loggedIn: boolean
	loginHref: string
	viewerInstall: ViewerListingInstall | null
}

/**
 * Everything the repository action group can offer on any tab (Repo, Files,
 * Settings). Built on the server from the package page so each tab renders
 * the same group; null fields render nothing.
 */
export type PackageRepoActions = {
	/**
	 * Visitors on a listed package, or signed-in readers of a package with no
	 * listing. Owners never fork their own listing.
	 */
	fork: PackageRepoForkAction | null
	/** Owner: default-branch HEAD is ahead of the last publish. */
	publishHref: string | null
	/**
	 * Open app. Someone who may run the app (`app:execute`) gets
	 * `/@{user}/packages/{name}/open`, which hands off to the hosted origin
	 * (verified app custom hostname when one exists, else the kody.run
	 * subdomain). Everyone else gets that same hosted origin only when the
	 * app is approved for anonymous serving. Inline deployments use the path
	 * mount. There is no second host-labeled button.
	 */
	packageAppHref: string | null
	/**
	 * Reserved for settings/details that once showed a second hosted-origin
	 * link. Always null from `resolvePackageAppLinks`; Open app is the only
	 * control.
	 */
	packageAppOriginHref?: string | null
	follow?: PackageRepoFollowAction | null
}

export type PackageRepoFollowAction = {
	kind: 'package' | 'repo'
	loggedIn: boolean
	loginHref: string
	repoHref: string
	following: boolean
}
export const PACKAGE_FOLLOW_PANEL_ID = 'package-follow-panel'
export const PACKAGE_FOLLOW_HASH = '#follow'
