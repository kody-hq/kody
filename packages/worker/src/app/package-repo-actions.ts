import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { type PackagePageAccess } from '#app/package-page.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { type PackageRepoActions } from '#universal/package-repo-actions.ts'
import { routes } from '#universal/routes.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
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
	/**
	 * Overrides the owner path mount. The page loader sets this to the
	 * handoff entry or the canonical hosted origin.
	 */
	packageAppHref?: string | null
	/** Canonical kody.run or custom-domain URL, when one exists. */
	packageAppOriginHref?: string | null
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
		input.packageAppHref !== undefined
			? input.packageAppHref
			: input.viewerIsOwner && input.ownerPackage?.hasApp === true
				? buildPackageAppPath({
						username: input.username,
						kodyId: input.kodyId,
					})
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
	return {
		fork,
		publishHref,
		packageAppHref,
		packageAppOriginHref: input.packageAppOriginHref ?? null,
		follow,
	}
}

type PackageAppLinkFlags = {
	hasApp: boolean
	isInternetVisible: boolean
}

/**
 * Href for "Open app", plus the canonical hosted origin when it differs.
 *
 * Session-gated apps keep the app-origin handoff path for people who may run
 * them: `*.kody.run` and custom domains only authenticate through that token.
 * Internet-visible apps link straight at the canonical origin for everyone
 * else. Inline deployments (no package-app origin) keep the path mount,
 * because that is where the app actually runs.
 */
export async function resolvePackageAppLinks(input: {
	env: Env
	username: string
	kodyId: string
	viewerIsOwner: boolean
	hasPackage: boolean
	ownerUserId?: string
	hasApp?: boolean
	isInternetVisible?: boolean
}): Promise<{
	packageAppHref: string | null
	packageAppOriginHref: string | null
} | null> {
	const flags = await loadPackageAppLinkFlags(input)
	if (!flags) return null
	if (!flags.hasApp) {
		return { packageAppHref: null, packageAppOriginHref: null }
	}
	const pathHref = buildPackageAppPath({
		username: input.username,
		kodyId: input.kodyId,
	})
	const packageAppOrigin = getPackageAppBaseUrl({ env: input.env })
	if (!packageAppOrigin) {
		const showInline = input.viewerIsOwner || flags.isInternetVisible
		return {
			packageAppHref: showInline ? pathHref : null,
			packageAppOriginHref: null,
		}
	}
	const canonical =
		(
			await resolvePublicPackageAppLocation({
				env: input.env,
				username: input.username,
				kodyId: input.kodyId,
			})
		)?.hostedUrl ?? null
	// Owners still need the handoff so a private app (and a signed-in session
	// on an internet-visible app) actually opens. Visitors of an
	// internet-visible app go straight to the hosted origin.
	if (input.viewerIsOwner) {
		return {
			packageAppHref: pathHref,
			packageAppOriginHref: canonical,
		}
	}
	if (flags.isInternetVisible && canonical) {
		return {
			packageAppHref: canonical,
			packageAppOriginHref: canonical,
		}
	}
	return { packageAppHref: null, packageAppOriginHref: null }
}

async function loadPackageAppLinkFlags(input: {
	env: Env
	username: string
	kodyId: string
	hasPackage: boolean
	ownerUserId?: string
	hasApp?: boolean
	isInternetVisible?: boolean
}): Promise<PackageAppLinkFlags | null> {
	if (typeof input.hasApp === 'boolean') {
		return {
			hasApp: input.hasApp,
			isInternetVisible: input.isInternetVisible === true,
		}
	}
	if (!input.hasPackage) return { hasApp: false, isInternetVisible: false }
	try {
		const ownerUserId =
			input.ownerUserId ??
			(
				await resolvePackageAppOrgOwnerByHandle({
					env: input.env,
					handle: input.username,
				})
			)?.userId
		if (!ownerUserId) return { hasApp: false, isInternetVisible: false }
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: ownerUserId,
			slug: input.kodyId,
		})
		const saved = lookup?.savedPackage
		if (!saved) return { hasApp: false, isInternetVisible: false }
		return {
			hasApp: saved.hasApp,
			isInternetVisible: saved.isInternetVisible,
		}
	} catch {
		return null
	}
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

export async function buildPackageRepoActionsForPage(
	page: Extract<PackagePageAccess, { kind: 'page' }>,
	env: Env,
) {
	const owner = page.ownerPackage
	const actions = buildPackageRepoActions({
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
	const links = await resolvePackageAppLinks({
		env,
		username: page.username,
		kodyId: page.kodyId,
		viewerIsOwner: page.viewerIsOwner,
		hasPackage: page.hasPackage,
		ownerUserId: page.ownerUserId,
		hasApp: owner ? owner.hasApp : undefined,
		isInternetVisible: owner ? owner.isInternetVisible : undefined,
	})
	if (!links) return actions
	return { ...actions, ...links }
}
