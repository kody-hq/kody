import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { viewerCanReadSavedPackage } from '#app/package-viewer-access.ts'
import {
	identityIconNotFound,
	ownerIdentityIconCacheControl,
	serveIdentityIcon,
} from './identity-icon-response.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { resolvePackagePageUrl } from '#worker/community/package-url.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	getEntitySourceByEntity,
	getEntitySourceById,
} from '#worker/repo/entity-sources.ts'
import { identityIconCommitForSource } from '#worker/repo/identity-icon.ts'
import { getUserRepoByName } from '#worker/repo/user-repos.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

function isGuestVisiblePackage(pkg: { hidden: boolean; isPrivate: boolean }) {
	return !pkg.hidden && !pkg.isPrivate
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

export function createCommunityPackageIconHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { username: string; kodyId: string; iconCommit: string }
	}) => {
		const [target, user] = await Promise.all([
			resolvePackagePageUrl({
				db: env.APP_DB,
				username: params.username,
				kodyId: params.kodyId,
			}),
			readAuthenticatedAppUser(request, env),
		])
		if (target?.kind === 'redirect') {
			return identityIconNotFound()
		}

		if (target?.kind === 'package' && target.savedPackage) {
			return await servePackageIdentityIcon({
				env,
				user,
				userId: target.userId,
				savedPackage: target.savedPackage,
				listingId: target.listingId,
				iconCommit: params.iconCommit,
			})
		}

		return await servePlainRepoIdentityIcon({
			env,
			user,
			username: params.username,
			kodyId: params.kodyId,
			iconCommit: params.iconCommit,
		})
	}
}

async function servePackageIdentityIcon(input: {
	env: Env
	user: Awaited<ReturnType<typeof readAuthenticatedAppUser>>
	userId: OwnerId
	savedPackage: SavedPackageRecord
	listingId: string | null
	iconCommit: string
}) {
	const { env, user, userId, savedPackage } = input
	const listing = input.listingId
		? await getCommunityListingById(env.APP_DB, {
				listingId: input.listingId,
				includeDelisted: false,
			})
		: null
	const guestVisible = Boolean(listing) || isGuestVisiblePackage(savedPackage)
	if (
		!guestVisible &&
		!(await viewerCanReadSavedPackage({
			env,
			viewer: user?.mcpUser ?? null,
			ownerId: userId,
			packageId: savedPackage.id,
		}))
	) {
		return identityIconNotFound()
	}

	const source = await getEntitySourceById(env.APP_DB, savedPackage.sourceId)
	if (
		!source ||
		source.user_id !== userId ||
		source.entity_kind !== 'package'
	) {
		return identityIconNotFound()
	}

	const publishedCommit = source.published_commit
	const listingCommits = listing
		? [listing.iconCommit, listing.pinnedCommit]
		: []
	const allowedCommits = [publishedCommit, ...listingCommits].filter(
		(commit): commit is string => Boolean(commit),
	)
	if (!allowedCommits.includes(input.iconCommit)) {
		return identityIconNotFound()
	}

	return await serveIdentityIcon({
		env,
		repoId: source.repo_id,
		iconCommit: input.iconCommit,
		ownerUserId: userId,
		leafName: savedPackage.kodyId,
		includePackageAppIcon: true,
		cacheControl: guestVisible ? undefined : ownerIdentityIconCacheControl,
		isServableCommit: async () => {
			const current = await getEntitySourceById(env.APP_DB, source.id)
			if (
				!current ||
				current.user_id !== userId ||
				current.entity_kind !== 'package'
			) {
				return false
			}
			const currentListing = input.listingId
				? await getCommunityListingById(env.APP_DB, {
						listingId: input.listingId,
						includeDelisted: false,
					})
				: null
			return (
				input.iconCommit === current.published_commit ||
				input.iconCommit === currentListing?.iconCommit ||
				input.iconCommit === currentListing?.pinnedCommit
			)
		},
		logLabel: 'package-identity-icon',
	})
}

/**
 * Same URL shape as packages (`/@owner/leaf/icon/:commit`). Access mirrors
 * loadPlainRepoPage: public repos for anyone, private for org members.
 */
async function servePlainRepoIdentityIcon(input: {
	env: Env
	user: Awaited<ReturnType<typeof readAuthenticatedAppUser>>
	username: string
	kodyId: string
	iconCommit: string
}) {
	const username = normalizeUsername(input.username.trim())
	const slug = input.kodyId.trim().toLowerCase()
	if (!username || !slug) return identityIconNotFound()

	const identity = await findPublicOwnerIdentityByHandle({
		db: input.env.APP_DB,
		handle: username,
	})
	if (!identity) return identityIconNotFound()

	const repo = await getUserRepoByName(input.env.APP_DB, {
		userId: identity.ownerId,
		name: slug,
	})
	if (!repo) return identityIconNotFound()

	const viewer = input.user?.mcpUser ?? null
	const canAccess = await viewerCanAccessPlainRepo({
		env: input.env,
		viewer,
		ownerUserId: identity.ownerId,
		isPrivate: repo.isPrivate,
	})
	if (!canAccess) return identityIconNotFound()

	const source = await getEntitySourceByEntity(input.env.APP_DB, {
		userId: identity.ownerId,
		entityKind: 'repo',
		entityId: repo.id,
	})
	if (!source) return identityIconNotFound()

	const iconCommit = identityIconCommitForSource(source)
	if (!iconCommit || input.iconCommit !== iconCommit) {
		return identityIconNotFound()
	}

	return await serveIdentityIcon({
		env: input.env,
		repoId: source.repo_id,
		iconCommit: input.iconCommit,
		ownerUserId: identity.ownerId,
		leafName: repo.name,
		includePackageAppIcon: false,
		cacheControl: repo.isPrivate ? ownerIdentityIconCacheControl : undefined,
		isServableCommit: async () => {
			const current = await getEntitySourceByEntity(input.env.APP_DB, {
				userId: identity.ownerId,
				entityKind: 'repo',
				entityId: repo.id,
			})
			return (
				current != null &&
				identityIconCommitForSource(current) === input.iconCommit
			)
		},
		logLabel: 'repo-identity-icon',
	})
}
