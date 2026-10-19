import { loadAccountPackageDetail } from '#app/account-packages-data.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	viewerCanDeleteSavedPackage,
	viewerCanExecutePackageApp,
	viewerCanManageSavedPackage,
	viewerCanManageSavedPackageAccess,
	viewerCanPublishSavedPackage,
	viewerCanReadSavedPackage,
	viewerIsSavedPackageOrgOwner,
} from '#app/package-viewer-access.ts'
import { resolvePackageAppLinks } from '#app/package-repo-actions.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import {
	memoizePerRequest,
	recordServerTiming,
} from '#worker/request-context.ts'
import {
	getCommunityPackageHref,
	resolvePackagePageUrl,
} from '#worker/community/package-url.ts'
import { isPlainRepoPackageShapedAtCommit } from '#mcp/capabilities/repo/plain-repo-package-shaped.ts'
import { resolveCachedArtifactSourceHead } from '#worker/repo/artifact-head-cache.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import { getUserRepoByName } from '#worker/repo/user-repos.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { viewerOrgsFollowTarget } from '#worker/follow/repo.ts'
import { type FollowTargetKind } from '#worker/follow/types.ts'
import {
	type AccountPackageDetail,
	type CommunityDetailLoaderData,
} from '#universal/loader-data.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

export type PackagePageAccess =
	| { kind: 'redirect'; to: string; shared: boolean }
	| { kind: 'not_found' }
	| { kind: 'unauthorized' }
	/**
	 * Signed-in viewer reached a real saved package they cannot read. Distinct
	 * from `not_found` so a shared private-app link never looks like the
	 * package was deleted — show "you don't have access" with a request path.
	 * Anonymous visitors still get `not_found` so private packages stay opaque.
	 */
	| {
			kind: 'no_access'
			username: string
			kodyId: string
			packageName: string
			viewerUsername: string
			/**
			 * Canonical hosted origin when the app is internet-visible. The
			 * package page is closed, but the app itself is not.
			 */
			packageAppHref?: string | null
	  }
	| {
			kind: 'page'
			username: string
			kodyId: string
			listing: CommunityDetailLoaderData | null
			ownerPackage: AccountPackageDetail | null
			/**
			 * True when this URL resolves to a saved package (or its listing).
			 * False for plain `user_repos` pages that share the same chrome.
			 */
			hasPackage: boolean
			/**
			 * Plain repos only: root `package.json` at the indexed/published
			 * commit. Computed for org members so the detail chrome can offer
			 * promote guidance; guests skip the Artifacts read.
			 */
			packageShaped?: boolean
			/** The viewer may open the private view (details, source files). */
			viewerIsOwner: boolean
			/** The viewer may change the package (settings, publish). */
			viewerCanManage: boolean
			viewerCanPublish: boolean
			viewerCanDelete: boolean
			/** May change who can use the package (`package:manage_access`). */
			viewerCanManageAccess: boolean
			/** May adopt a community fork (org owner only; widens secret access). */
			viewerCanAdoptCommunityFork: boolean
			/**
			 * The viewer may run this package's hosted app (`app:execute`).
			 * Distinct from `viewerIsOwner`, which is `package:read`.
			 */
			viewerMayRun?: boolean
			loggedIn: boolean
			/** Saved package or plain repo a Follow control acts on. */
			followTarget: { kind: FollowTargetKind; id: string } | null
			/** One of the viewer's orgs follows this target (active or paused). */
			viewerFollowing?: boolean
			invocationUrlOrigin: string
			ownerUserId: string
			/** True when `/@owner` is publicly reachable. */
			ownerProfilePublic: boolean
	  }

export type PackagePagePrivacySource = {
	ownerPackage: { isPrivate: boolean } | null
}

export function packagePageIsPrivate(page: PackagePagePrivacySource): boolean {
	return page.ownerPackage?.isPrivate ?? false
}

/**
 * Client JSON must not leak internal source ids for plain repos to guests.
 * Owners keep sourceId for settings/debug surfaces; packages keep current
 * behavior (source ids already appear on saved-package payloads).
 */
export function ownerPackageForClient(input: {
	ownerPackage: AccountPackageDetail | null
	hasPackage: boolean
	viewerIsOwner: boolean
}): AccountPackageDetail | null {
	const ownerPackage = input.ownerPackage
	if (!ownerPackage) return null
	if (input.hasPackage || input.viewerIsOwner) return ownerPackage
	if (!ownerPackage.sourceId) return ownerPackage
	return { ...ownerPackage, sourceId: '' }
}

function isPublicSavedPackage(pkg: { hidden: boolean; isPrivate: boolean }) {
	return !pkg.hidden && !pkg.isPrivate
}

async function resolvePackagePageOwnerProfilePublic(input: {
	env: Env
	username: string
	listing: CommunityDetailLoaderData | null
}) {
	if (typeof input.listing?.ownerProfilePublic === 'boolean') {
		return input.listing.ownerProfilePublic
	}
	const row = await getUserSocialRowByUsername(input.env.APP_DB, input.username)
	return row?.profile_visibility === 'public'
}

function sameKodyId(left: string, right: string) {
	return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/**
 * One SSR request resolves the same package several times: the page handler,
 * the `community-detail` frame rendered while the response streams, and the
 * files loader that gates on the same access decision. Memoize per request so
 * the URL resolution, auth, and detail loads run once.
 */
export function loadPackagePage(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	/**
	 * Viewer already authenticated another way (a `kody_at_` bearer on raw
	 * file reads). Omit to read the session cookie; `null` is anonymous.
	 */
	viewer?: McpUserContext | null
}): Promise<PackagePageAccess> {
	const viewerKey =
		input.viewer === undefined
			? 'session'
			: `viewer:${input.viewer?.userId ?? 'anonymous'}`
	return memoizePerRequest({
		request: input.request,
		key: `package-page:${input.username}:${input.kodyId}:${viewerKey}`,
		load: () =>
			recordServerTiming(
				'package-page',
				() => loadPackagePageUncached(input),
				input.request,
			),
	})
}

async function viewerCanAccessPlainRepo(input: {
	env: Env
	viewer: McpUserContext | null
	ownerUserId: string
	isPrivate: boolean
}) {
	if (!input.isPrivate) return true
	if (!input.viewer) return false
	const membership = await input.env.APP_DB.prepare(
		`SELECT 1 AS ok FROM org_memberships
		 WHERE org_id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.ownerUserId, input.viewer.userId)
		.first<{ ok: number }>()
	return membership != null
}

function toPlainRepoOwnerPackage(input: {
	username: string
	repo: {
		id: string
		name: string
		description: string | null
		isPrivate: boolean
		createdAt: string
		updatedAt: string
	}
	sourceId: string
	iconCommit: string | null
}): AccountPackageDetail {
	return {
		id: input.repo.id,
		name: `@${input.username}/${input.repo.name}`,
		kodyId: input.repo.name,
		description: input.repo.description ?? '',
		tags: [],
		hasApp: false,
		sourceId: input.sourceId,
		lockedAt: null,
		createdAt: input.repo.createdAt,
		updatedAt: input.repo.updatedAt,
		hidden: false,
		isPrivate: input.repo.isPrivate,
		isInternetVisible: false,
		hasCommunityListing: false,
		listingNeedsRepublish: false,
		listingAhead: null,
		forkAhead: null,
		searchText: null,
		exports: null,
		publishedCommit: input.iconCommit,
		pendingCommit: input.iconCommit,
		pendingCommitKnown: true,
		publishedVersion: null,
		unpublishedChangeCount: null,
		ownerIsPersonal: true,
		communityFork: null,
	}
}

async function loadPlainRepoPage(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	viewer: McpUserContext | null
}): Promise<PackagePageAccess> {
	const username = normalizeUsername(input.username.trim())
	const slug = input.kodyId.trim().toLowerCase()
	if (!username || !slug) return { kind: 'not_found' }
	const identity = await findPublicOwnerIdentityByHandle({
		db: input.env.APP_DB,
		handle: username,
	})
	if (!identity) return { kind: 'not_found' }
	const repo = await getUserRepoByName(input.env.APP_DB, {
		userId: identity.ownerId,
		name: slug,
	})
	if (!repo) return { kind: 'not_found' }

	const viewer = input.viewer
	const canAccess = await viewerCanAccessPlainRepo({
		env: input.env,
		viewer,
		ownerUserId: identity.ownerId,
		isPrivate: repo.isPrivate,
	})
	if (!canAccess) {
		return repo.isPrivate ? { kind: 'not_found' } : { kind: 'unauthorized' }
	}

	const source = await getEntitySourceByEntity(input.env.APP_DB, {
		userId: identity.ownerId,
		entityKind: 'repo',
		entityId: repo.id,
	})
	const iconCommit = source?.indexed_commit ?? source?.published_commit ?? null
	const viewerIsMember = viewer
		? await viewerCanAccessPlainRepo({
				env: input.env,
				viewer,
				ownerUserId: identity.ownerId,
				isPrivate: true,
			})
		: false
	// Match repoGet: probe package.json at live HEAD (not a possibly stale
	// indexed icon commit). Fall back to iconCommit when HEAD resolve fails.
	let headCommit = iconCommit
	if (source?.repo_id) {
		try {
			const head = await resolveCachedArtifactSourceHead(
				input.env,
				source.repo_id,
				{ request: input.request },
			)
			headCommit = head.commit
		} catch {
			headCommit = iconCommit
		}
	}
	let packageShaped = false
	if (viewerIsMember && source?.repo_id) {
		try {
			packageShaped = await isPlainRepoPackageShapedAtCommit({
				env: input.env,
				repoId: source.repo_id,
				commit: headCommit,
			})
		} catch {
			packageShaped = false
		}
	}
	const ownerProfilePublic = await resolvePackagePageOwnerProfilePublic({
		env: input.env,
		username: identity.handle,
		listing: null,
	})
	return {
		kind: 'page',
		username: identity.handle,
		kodyId: repo.name,
		listing: null,
		ownerPackage: toPlainRepoOwnerPackage({
			username: identity.handle,
			repo,
			// Keep sourceId server-side for owner README. Public JSON strips it
			// so guests never see internal ids.
			sourceId: source?.id ?? '',
			iconCommit,
		}),
		hasPackage: false,
		packageShaped,
		viewerIsOwner: viewerIsMember,
		// Plain repos have no package settings/publish/delete surface here.
		viewerCanManage: false,
		viewerCanPublish: false,
		viewerCanDelete: false,
		viewerCanManageAccess: false,
		viewerCanAdoptCommunityFork: false,
		loggedIn: Boolean(viewer),
		viewerMayRun: false,
		followTarget: { kind: 'repo', id: repo.id },
		invocationUrlOrigin: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		ownerUserId: identity.ownerId,
		ownerProfilePublic,
	}
}

async function loadPackagePageUncached(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	viewer?: McpUserContext | null
}): Promise<PackagePageAccess> {
	// The URL lookup only needs the pair; the viewer lookup only needs the
	// cookie. Neither waits on the other.
	const [target, viewer] = await Promise.all([
		recordServerTiming(
			'resolve-url',
			() =>
				resolvePackagePageUrl({
					db: input.env.APP_DB,
					username: input.username,
					kodyId: input.kodyId,
				}),
			input.request,
		),
		input.viewer === undefined
			? recordServerTiming(
					'auth',
					async () =>
						(await readAuthenticatedAppUser(input.request, input.env))
							?.mcpUser ?? null,
					input.request,
				)
			: input.viewer,
	])
	const page = await resolvePackagePageForViewer(input, target, viewer)
	if (page.kind !== 'page' || !viewer) return page
	const followTarget = page.followTarget
	if (!followTarget) return page
	return {
		...page,
		viewerFollowing: await recordServerTiming(
			'viewer-follow',
			() =>
				viewerOrgsFollowTarget(input.env.APP_DB, {
					personId: viewer.userId,
					targetKind: followTarget.kind,
					targetId: followTarget.id,
				}),
			input.request,
		),
	}
}

async function resolvePackagePageForViewer(
	input: {
		env: Env
		request: Request
		username: string
		kodyId: string
	},
	target: Awaited<ReturnType<typeof resolvePackagePageUrl>>,
	viewer: McpUserContext | null,
): Promise<PackagePageAccess> {
	if (!target) {
		return await loadPlainRepoPage({
			env: input.env,
			request: input.request,
			username: input.username,
			kodyId: input.kodyId,
			viewer,
		})
	}

	if (target.kind === 'redirect') {
		// A listing move is public. An unlisted rename must not leak the new
		// pair: only viewers who can see the package are sent to the current URL.
		if (
			!target.listingId &&
			!(await viewerCanReadSavedPackage({
				env: input.env,
				viewer,
				ownerId: target.userId,
				packageId: target.packageId,
			}))
		) {
			return { kind: 'not_found' }
		}
		const listingKodyId = target.listingKodyId
		const shared =
			Boolean(target.listingId) &&
			(listingKodyId == null || sameKodyId(target.kodyId, listingKodyId))
		return {
			kind: 'redirect',
			to: getCommunityPackageHref({
				username: target.username,
				kodyId: target.kodyId,
			}),
			// Shared caches may only store hops to the listing public pair.
			shared,
		}
	}

	const viewerIsOwner = target.savedPackage
		? await viewerCanReadSavedPackage({
				env: input.env,
				viewer,
				ownerId: target.userId,
				packageId: target.savedPackage.id,
			})
		: false
	const listingKodyId = target.listingKodyId
	const savedKodyId = target.savedPackage?.kodyId ?? null
	if (listingKodyId && savedKodyId && !sameKodyId(listingKodyId, savedKodyId)) {
		// Listing kody_id lags a local rename until republish. Owners may
		// hop to the unpublished pair; visitors stay on (or return to) the
		// listing URL.
		if (viewerIsOwner && sameKodyId(input.kodyId, listingKodyId)) {
			return {
				kind: 'redirect',
				to: getCommunityPackageHref({
					username: target.username,
					kodyId: savedKodyId,
				}),
				shared: false,
			}
		}
		if (!viewerIsOwner && sameKodyId(input.kodyId, savedKodyId)) {
			return {
				kind: 'redirect',
				to: getCommunityPackageHref({
					username: target.username,
					kodyId: listingKodyId,
				}),
				shared: true,
			}
		}
	}
	const invocationUrlOrigin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})

	if (viewerIsOwner && target.savedPackage) {
		const packageId = target.savedPackage.id
		const ownerId = target.userId
		const [
			viewerCanManage,
			viewerCanPublish,
			viewerCanDelete,
			viewerCanManageAccess,
			viewerCanAdoptCommunityFork,
			viewerMayRun,
		] = await Promise.all([
			viewerCanManageSavedPackage({
				env: input.env,
				viewer,
				ownerId,
				packageId,
			}),
			viewerCanPublishSavedPackage({
				env: input.env,
				viewer,
				ownerId,
				packageId,
			}),
			viewerCanDeleteSavedPackage({
				env: input.env,
				viewer,
				ownerId,
				packageId,
			}),
			viewerCanManageSavedPackageAccess({
				env: input.env,
				viewer,
				ownerId,
				packageId,
			}),
			viewerIsSavedPackageOrgOwner({
				env: input.env,
				viewer,
				ownerId,
			}),
			viewerCanExecutePackageApp({
				env: input.env,
				viewer,
				ownerId,
				appId: packageId,
			}),
		])
		const [listing, ownerPackage] = await Promise.all([
			target.listingId
				? loadCommunityDetailData(input.env, input.request, target.listingId)
				: Promise.resolve(null),
			loadAccountPackageDetail({
				env: input.env,
				requestUrl: input.request.url,
				userId: target.userId,
				...(viewerCanManage
					? { creditAttributionUsername: target.username }
					: {}),
				packageId: target.savedPackage.id,
			}),
		])
		const ownerProfilePublic = await resolvePackagePageOwnerProfilePublic({
			env: input.env,
			username: target.username,
			listing,
		})
		return {
			kind: 'page',
			username: target.username,
			kodyId: target.kodyId,
			listing,
			ownerPackage,
			hasPackage: true,
			viewerIsOwner: true,
			viewerCanManage,
			viewerCanPublish,
			viewerCanDelete,
			viewerCanManageAccess,
			viewerCanAdoptCommunityFork,
			viewerMayRun,
			loggedIn: true,
			followTarget: { kind: 'package', id: packageId },
			invocationUrlOrigin,
			ownerUserId: target.userId,
			ownerProfilePublic,
		}
	}

	if (target.listingId) {
		const [listing, viewerMayRun] = await Promise.all([
			loadCommunityDetailData(input.env, input.request, target.listingId),
			viewer && target.savedPackage
				? viewerCanExecutePackageApp({
						env: input.env,
						viewer,
						ownerId: target.userId,
						appId: target.savedPackage.id,
					})
				: Promise.resolve(false),
		])
		if (!listing) return { kind: 'not_found' }
		return {
			kind: 'page',
			username: target.username,
			kodyId: target.kodyId,
			listing,
			ownerPackage: null,
			hasPackage: true,
			viewerIsOwner: false,
			viewerCanManage: false,
			viewerCanPublish: false,
			viewerCanDelete: false,
			viewerCanManageAccess: false,
			viewerCanAdoptCommunityFork: false,
			viewerMayRun,
			loggedIn: Boolean(viewer),
			followTarget: target.savedPackage
				? { kind: 'package', id: target.savedPackage.id }
				: null,
			invocationUrlOrigin,
			ownerUserId: target.userId,
			ownerProfilePublic: listing.ownerProfilePublic,
		}
	}

	if (!target.savedPackage || !isPublicSavedPackage(target.savedPackage)) {
		// Package exists (or is hidden/private) but this viewer cannot open it.
		// Signed-in outsiders get an explicit no-access page — never the
		// generic "doesn't quite connect" 404 that made shared private-app
		// handoffs look like the package was gone. Anonymous visitors still
		// get not_found, so private packages stay opaque without a session.
		// Revealing existence to signed-in people who already know the URL
		// (share links / handoffs) is intentional product policy.
		if (viewer && target.savedPackage) {
			const mayRun = target.savedPackage.hasApp
				? await viewerCanExecutePackageApp({
						env: input.env,
						viewer,
						ownerId: target.userId,
						appId: target.savedPackage.id,
					})
				: false
			const links = target.savedPackage.hasApp
				? await resolvePackageAppLinks({
						env: input.env,
						requestUrl: input.request.url,
						username: target.username,
						kodyId: target.kodyId,
						viewerMayRun: mayRun,
						hasPackage: true,
						ownerUserId: target.userId,
						hasApp: true,
					})
				: null
			const packageAppHref = links?.packageAppHref ?? null
			return {
				kind: 'no_access',
				username: target.username,
				kodyId: target.kodyId,
				packageName: target.savedPackage.name,
				viewerUsername: viewer.username ?? 'unknown',
				...(packageAppHref ? { packageAppHref } : {}),
			}
		}
		return { kind: 'not_found' }
	}

	return { kind: 'unauthorized' }
}
