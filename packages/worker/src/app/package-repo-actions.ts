import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { type PackagePageAccess } from '#app/package-page.ts'
import { resolveInternetVisibleApprovedCommit } from '#app/package-app-internet-visible.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { type PackageRepoActions } from '#universal/package-repo-actions.ts'
import { routes } from '#universal/routes.ts'
import { getAppBaseUrl, getPackageAppBaseUrl } from '#worker/app-base-url.ts'
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
}

/**
 * Href for the single "Open app" control.
 *
 * When the app is approved for anonymous serving on the hosted origin
 * (`*.kody.run` or a verified custom domain), Open app points there for
 * everyone who may see it (runners and the public). Private or unapproved
 * apps still use the kody.codes handoff path for someone who may run them
 * (`app:execute`), because a direct hosted visit has no session. Readers who
 * cannot execute never get a link that would 403. Inline deployments (no
 * `PACKAGE_APP_BASE_URL`) keep the path mount. There is no second host
 * button: `packageAppOriginHref` stays null.
 */
export async function resolvePackageAppLinks(input: {
	env: Env
	username: string
	kodyId: string
	/**
	 * Precomputed `app:execute`. When omitted and `viewer` is set, this
	 * function checks. `false` means the caller already knows they cannot run it.
	 */
	viewerMayRun?: boolean
	viewer?: Pick<McpUserContext, 'userId' | 'username'> | null
	hasPackage: boolean
	ownerUserId?: string
	hasApp?: boolean
	requestUrl?: string
}): Promise<{
	packageAppHref: string | null
	packageAppOriginHref: string | null
} | null> {
	const flags = await loadPackageAppLinkFlags(input)
	if (!flags) return null
	if (!flags.hasApp) {
		return { packageAppHref: null, packageAppOriginHref: null }
	}
	const mayRun =
		input.viewerMayRun === true ||
		(input.viewerMayRun === undefined && input.viewer
			? await viewerMayRunPackageApp(input)
			: false)
	const publiclyServable = await appIsPubliclyServable(input)
	const pathHref = buildPackageAppPath({
		username: input.username,
		kodyId: input.kodyId,
	})
	const packageAppOrigin = getPackageAppBaseUrl({ env: input.env })
	if (!packageAppOrigin) {
		return {
			packageAppHref: mayRun || publiclyServable ? pathHref : null,
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
	if (publiclyServable && canonical) {
		return {
			packageAppHref: canonical,
			packageAppOriginHref: null,
		}
	}
	if (mayRun) {
		// Not internet-visible (or unapproved): handoff still attaches a
		// session. Do not offer a second control at the bare hosted URL.
		return {
			packageAppHref: pathHref,
			packageAppOriginHref: null,
		}
	}
	return { packageAppHref: null, packageAppOriginHref: null }
}

async function appIsPubliclyServable(input: {
	env: Env
	username: string
	kodyId: string
	ownerUserId?: string
	requestUrl?: string
}): Promise<boolean> {
	try {
		const ownerUserId = await resolveLinkOwnerUserId(input)
		if (!ownerUserId) return false
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: ownerUserId,
			slug: input.kodyId,
		})
		return Boolean(
			await resolveInternetVisibleApprovedCommit({
				env: input.env,
				lookup,
				requestUrl: input.requestUrl ?? getAppBaseUrl({ env: input.env }),
			}),
		)
	} catch {
		return false
	}
}

async function viewerMayRunPackageApp(input: {
	env: Env
	username: string
	kodyId: string
	ownerUserId?: string
	viewer?: Pick<McpUserContext, 'userId' | 'username'> | null
}): Promise<boolean> {
	if (!input.viewer) return false
	try {
		const ownerUserId = await resolveLinkOwnerUserId(input)
		if (!ownerUserId) return false
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: ownerUserId,
			slug: input.kodyId,
		})
		if (!lookup?.savedPackage.hasApp) return false
		return await viewerCanExecutePackageApp({
			env: input.env,
			viewer: input.viewer,
			ownerId: ownerUserId,
			appId: lookup.savedPackage.id,
		})
	} catch {
		return false
	}
}

async function resolveLinkOwnerUserId(input: {
	env: Env
	username: string
	ownerUserId?: string
}): Promise<string | null> {
	if (input.ownerUserId) return input.ownerUserId
	const org = await resolvePackageAppOrgOwnerByHandle({
		env: input.env,
		handle: input.username,
	})
	return org?.userId ?? null
}

async function loadPackageAppLinkFlags(input: {
	env: Env
	username: string
	kodyId: string
	hasPackage: boolean
	ownerUserId?: string
	hasApp?: boolean
}): Promise<PackageAppLinkFlags | null> {
	if (typeof input.hasApp === 'boolean') {
		return { hasApp: input.hasApp }
	}
	if (!input.hasPackage) return { hasApp: false }
	try {
		const ownerUserId = await resolveLinkOwnerUserId(input)
		if (!ownerUserId) return { hasApp: false }
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: ownerUserId,
			slug: input.kodyId,
		})
		return { hasApp: lookup?.savedPackage.hasApp === true }
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
	request?: Request,
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
		requestUrl: request?.url,
		username: page.username,
		kodyId: page.kodyId,
		viewerMayRun: page.viewerMayRun === true,
		hasPackage: page.hasPackage,
		ownerUserId: page.ownerUserId,
		hasApp: owner ? owner.hasApp : undefined,
	})
	if (!links) return actions
	return { ...actions, ...links }
}
