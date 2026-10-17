import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { type PackagePageAccess } from '#app/package-page.ts'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { type PackageRepoActions } from '#universal/package-repo-actions.ts'
import { routes } from '#universal/routes.ts'
import { buildPackagePublishApprovalPath } from '#worker/package-registry/package-publish-lock.ts'

export function buildSourceAheadPublishHref(input: {
	username: string
	kodyId: string
	headCommit: string | null | undefined
}) {
	if (input.headCommit) {
		return buildPackagePublishApprovalPath({
			username: input.username,
			kodyId: input.kodyId,
			commit: input.headCommit,
		})
	}
	return routes.communityPackageApprovePublish.href({
		username: input.username,
		kodyId: input.kodyId,
	})
}

/**
 * One action model for every package tab (Repo frame, Files payload, Settings
 * shell and API). The fork login link returns to the Repo tab, so the model
 * stays the same for every anonymous visitor and the anonymous files payload
 * remains shareable.
 */
export type PackageRepoOwnerPackageActions = {
	hasApp: boolean
	listingNeedsRepublish?: boolean
	/**
	 * Default-branch HEAD is newer than `published_commit`. Set for saved
	 * packages even when there is no community listing yet — owners still need
	 * Publish changes on the Repo tab.
	 */
	sourceAhead?: boolean
	headCommit?: string | null
}

export function buildPackageRepoActions(input: {
	username: string
	kodyId: string
	listing: PublicCommunityListing | null
	/** Page-level overlay; wins over the listing row's copy when both exist. */
	viewerInstall?: ViewerListingInstall | null
	viewerIsOwner: boolean
	viewerCanManage: boolean
	loggedIn: boolean
	ownerPackage: PackageRepoOwnerPackageActions | null
	/** Set when the page names a followable package or plain repo. */
	follow?: { kind: 'package' | 'repo'; viewerFollowing: boolean } | null
}): PackageRepoActions {
	const { listing } = input
	const repoHref = routes.communityPackage.href({
		username: input.username,
		kodyId: input.kodyId,
	})
	const fork =
		listing && !input.viewerIsOwner
			? {
					listingId: listing.id,
					trusted: listing.trusted,
					loggedIn: input.loggedIn,
					loginHref: routes.login.href(null, {
						searchParams: { redirectTo: repoHref },
					}),
					viewerInstall: input.viewerInstall ?? listing.viewerInstall ?? null,
				}
			: null
	const listingAhead = listing?.sourceAhead === true
	const ownerAhead = input.ownerPackage?.sourceAhead === true
	const publishHref =
		input.viewerCanManage && (listingAhead || ownerAhead)
			? buildSourceAheadPublishHref({
					username: listing?.ownerUsername ?? input.username,
					kodyId: listing?.kodyId ?? input.kodyId,
					headCommit: listingAhead
						? listing?.headCommit
						: (input.ownerPackage?.headCommit ?? null),
				})
			: null
	const packageAppHref =
		input.viewerIsOwner && input.ownerPackage?.hasApp === true
			? buildPackageAppPath({ username: input.username, kodyId: input.kodyId })
			: null
	const follow = input.follow
		? {
				kind: input.follow.kind,
				loggedIn: input.loggedIn,
				loginHref: routes.login.href(null, {
					searchParams: { redirectTo: repoHref },
				}),
				repoHref,
				following: input.loggedIn && input.follow.viewerFollowing,
			}
		: null
	return { fork, publishHref, packageAppHref, follow }
}

function ownerPackageSourceAhead(ownerPackage: {
	pendingCommitKnown: boolean
	pendingCommit: string | null
	publishedCommit: string | null
}): boolean {
	if (!ownerPackage.pendingCommitKnown) return false
	if (!ownerPackage.pendingCommit) return false
	return ownerPackage.pendingCommit !== ownerPackage.publishedCommit
}

export function buildPackageRepoActionsForPage(
	page: Extract<PackagePageAccess, { kind: 'page' }>,
) {
	const owner = page.ownerPackage
	return buildPackageRepoActions({
		username: page.username,
		kodyId: page.kodyId,
		listing: page.listing?.listing ?? null,
		viewerInstall: page.listing?.viewerInstall,
		viewerIsOwner: page.viewerIsOwner,
		viewerCanManage: page.viewerCanManage,
		loggedIn: page.loggedIn,
		ownerPackage: owner
			? {
					hasApp: owner.hasApp,
					listingNeedsRepublish: owner.listingNeedsRepublish,
					sourceAhead: ownerPackageSourceAhead(owner),
					headCommit: owner.pendingCommit,
				}
			: null,
		follow: page.followTarget
			? {
					kind: page.followTarget.kind,
					viewerFollowing: page.viewerFollowing === true,
				}
			: null,
	})
}
