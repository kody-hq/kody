import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { CommunityActionError } from './errors.ts'
import {
	countActiveListingsForOwner,
	countPublicSavedPackagesForUser,
	countWebhooksByPackageId,
	getUserSocialRowByStableId,
	getUserSocialRowByUsername,
	listCommunityActivityForActors,
	listPublicProfilePackages as listPublicProfilePackagesFromDb,
	listPublicProfileRepos as listPublicProfileReposFromDb,
	resolveCommunityDisplayName,
	updateUserProfileFields,
	type UserSocialRow,
} from './profile-repo.ts'
import {
	type CommunityActivityItem,
	type CommunityProfileRecord,
	type ProfileVisibility,
	type PublicProfilePackage,
	type PublicProfilePackageListRow,
} from './types.ts'

const maxDisplayNameLength = 50
const maxBioLength = 500

function resolveStableUserIdFromRow(row: UserSocialRow): OwnerId {
	return ownerIdFromStored(row.stable_user_id)
}

function toCommunityProfileRecord(input: {
	row: UserSocialRow
	stableUserId: string
	publicPackageCount: number
	listingCount: number
}): CommunityProfileRecord {
	return {
		userId: input.stableUserId,
		username: input.row.username,
		displayName: resolveCommunityDisplayName({
			displayName: input.row.display_name,
			username: input.row.username,
		}),
		bio: input.row.bio,
		avatarKey: input.row.avatar_key,
		visibility: input.row.profile_visibility,
		joinedAt: input.row.created_at,
		publicPackageCount: input.publicPackageCount,
		listingCount: input.listingCount,
	}
}

async function loadCommunityProfileFromRow(input: {
	env: Env
	row: UserSocialRow
	includePrivate: boolean
}): Promise<CommunityProfileRecord | null> {
	if (input.row.profile_visibility === 'private' && !input.includePrivate) {
		return null
	}
	const stableUserId = resolveStableUserIdFromRow(input.row)
	// Inventory is keyed by personal org id, not person id (ADR 0063 / #3053).
	const ownerOrgId = personalOrgIdFromUserRow(input.row)
	const [publicPackageCount, listingCount] = await Promise.all([
		countPublicSavedPackagesForUser(input.env.APP_DB, ownerOrgId),
		countActiveListingsForOwner(input.env.APP_DB, ownerOrgId),
	])
	return toCommunityProfileRecord({
		row: input.row,
		stableUserId,
		publicPackageCount,
		listingCount,
	})
}

export async function getCommunityProfileByUsername(input: {
	env: Env
	username: string
	includePrivate?: boolean
}): Promise<CommunityProfileRecord | null> {
	const row = await getUserSocialRowByUsername(input.env.APP_DB, input.username)
	if (!row) return null
	return await loadCommunityProfileFromRow({
		env: input.env,
		row,
		includePrivate: input.includePrivate ?? false,
	})
}

export async function getCommunityProfileByStableId(input: {
	env: Env
	stableUserId: string
	includePrivate?: boolean
}): Promise<CommunityProfileRecord | null> {
	const row = await getUserSocialRowByStableId(
		input.env.APP_DB,
		input.stableUserId,
	)
	if (!row) return null
	return await loadCommunityProfileFromRow({
		env: input.env,
		row,
		includePrivate: input.includePrivate ?? false,
	})
}

export async function updateCommunityProfile(input: {
	env: Env
	numericUserId: number
	displayName?: string
	bio?: string
	visibility?: ProfileVisibility
}): Promise<void> {
	const patch: {
		displayName?: string | null
		bio?: string | null
		visibility?: ProfileVisibility
	} = {}

	if (input.displayName !== undefined) {
		const trimmed = input.displayName.trim()
		if (trimmed.length > maxDisplayNameLength) {
			throw new CommunityActionError(
				`Display name must be at most ${maxDisplayNameLength} characters.`,
			)
		}
		patch.displayName = trimmed.length === 0 ? null : trimmed
	}
	if (input.bio !== undefined) {
		const trimmed = input.bio.trim()
		if (trimmed.length > maxBioLength) {
			throw new CommunityActionError(
				`Bio must be at most ${maxBioLength} characters.`,
			)
		}
		patch.bio = trimmed.length === 0 ? null : trimmed
	}
	if (input.visibility !== undefined) {
		if (input.visibility !== 'public' && input.visibility !== 'private') {
			throw new CommunityActionError('Profile visibility is invalid.')
		}
		patch.visibility = input.visibility
	}

	if (
		patch.displayName === undefined &&
		patch.bio === undefined &&
		patch.visibility === undefined
	) {
		return
	}

	await updateUserProfileFields(input.env.APP_DB, {
		numericUserId: input.numericUserId,
		...patch,
	})
	if (patch.visibility !== undefined) {
		invalidateCommunityPublicCache()
	}
}

export async function getProfileActivity(input: {
	env: Env
	actorUserId: string
	limit: number
	isSelf: boolean
}): Promise<Array<CommunityActivityItem>> {
	return await listCommunityActivityForActors(input.env.APP_DB, {
		actorUserIds: [input.actorUserId],
		limit: input.limit,
		requirePublicActorProfile: !input.isSelf,
	})
}

export async function listPublicProfilePackages(input: {
	env: Env
	ownerStableUserId: string
	query?: string
	limit?: number
	includePrivate?: boolean
}): Promise<Array<PublicProfilePackage>> {
	const packages = await listPublicProfilePackagesFromDb(input.env.APP_DB, {
		ownerStableUserId: input.ownerStableUserId,
		query: input.query,
		limit: input.limit,
		includePrivate: input.includePrivate,
	})
	return await attachProfilePackageSignifierCounts({
		env: input.env,
		ownerStableUserId: input.ownerStableUserId,
		packages,
	})
}

function compareProfileRepositoryUpdatedDesc(
	left: PublicProfilePackage,
	right: PublicProfilePackage,
) {
	const byUpdated = right.updatedAt.localeCompare(left.updatedAt)
	if (byUpdated !== 0) return byUpdated
	return left.kodyId.localeCompare(right.kodyId)
}

/**
 * Saved packages plus plain repos for `/@slug/-/repositories` and the public
 * profile list. MCP `communityProfileGet` keeps packages-only via
 * {@link listPublicProfilePackages}; plain repos stay on `repoList`.
 */
export async function listProfileRepositories(input: {
	env: Env
	ownerStableUserId: string
	ownerUsername: string
	query?: string
	limit?: number
	includePrivate?: boolean
}): Promise<Array<PublicProfilePackage>> {
	// Fetch both uncapped, then merge and apply `limit` so a full package
	// page cannot crowd out plain repos (and the reverse).
	const [packages, repos] = await Promise.all([
		listPublicProfilePackages({
			env: input.env,
			ownerStableUserId: input.ownerStableUserId,
			...(input.query ? { query: input.query } : {}),
			includePrivate: input.includePrivate,
		}),
		listPublicProfileReposFromDb(input.env.APP_DB, {
			ownerStableUserId: input.ownerStableUserId,
			ownerUsername: input.ownerUsername,
			...(input.query ? { query: input.query } : {}),
			includePrivate: input.includePrivate,
		}),
	])
	// One URL namespace (`/@owner/leaf`): when a saved package and plain repo
	// share a leaf, keep the package — the page resolver already prefers it.
	const byLeaf = new Map<string, (typeof packages)[number]>()
	for (const item of [...packages, ...repos]) {
		const key = item.kodyId.toLowerCase()
		const existing = byLeaf.get(key)
		if (!existing || (item.hasPackage && !existing.hasPackage)) {
			byLeaf.set(key, item)
		}
	}
	const merged = [...byLeaf.values()].sort(compareProfileRepositoryUpdatedDesc)
	return input.limit == null ? merged : merged.slice(0, input.limit)
}

async function attachProfilePackageSignifierCounts(input: {
	env: Env
	ownerStableUserId: string
	packages: Array<PublicProfilePackageListRow>
}): Promise<Array<PublicProfilePackage>> {
	if (input.packages.length === 0) return []
	const [webhookCounts, jobCountRows] = await Promise.all([
		countWebhooksByPackageId(input.env.APP_DB, {
			ownerStableUserId: input.ownerStableUserId,
			packageIds: input.packages.map((pkg) => pkg.packageId),
		}).catch(() => new Map<string, number>()),
		jobsData(input.env)
			.countJobsBySourceId({ userId: input.ownerStableUserId })
			.catch(() => []),
	])
	const jobCounts = new Map(
		jobCountRows.map((row) => [row.sourceId, row.count] as const),
	)
	return input.packages.map(({ sourceId, ...pkg }) => ({
		...pkg,
		webhookCount: webhookCounts.get(pkg.packageId) ?? 0,
		jobCount: jobCounts.get(sourceId) ?? 0,
	}))
}
