import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { viewerCanReadSavedPackage } from '#app/package-viewer-access.ts'
import {
	type CommunityForkListRow,
	countCommunityForksByListingIds,
	listPrivateCommunityForkCandidatesForPerson,
	listPublicCommunityForks,
} from '#worker/community/repo.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import { type PackageForkView } from '#universal/package-forks.ts'
import { routes } from '#universal/routes.ts'

export const packageForksPageLimit = 100

/**
 * Private or hidden forks of a listing this viewer may read. Org membership
 * narrows the candidates in SQL; `package:read` on each fork package decides.
 */
export async function loadViewerPrivateCommunityForks(input: {
	env: Env
	listingId: string
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
}): Promise<Array<CommunityForkListRow>> {
	const viewer = input.viewer
	if (!viewer) return []
	const candidates = await listPrivateCommunityForkCandidatesForPerson(
		input.env.APP_DB,
		{ listingId: input.listingId, personId: viewer.userId },
	)
	if (candidates.length === 0) return []
	const readable = await Promise.all(
		candidates.map((fork) =>
			viewerCanReadSavedPackage({
				env: input.env,
				viewer,
				ownerId: fork.ownerId,
				packageId: fork.packageId,
			}),
		),
	)
	return candidates.filter((_, index) => readable[index])
}

function compareForksNewestFirst(
	left: CommunityForkListRow,
	right: CommunityForkListRow,
) {
	if (left.createdAt !== right.createdAt)
		return left.createdAt > right.createdAt ? -1 : 1
	return left.forkId < right.forkId ? -1 : 1
}

function toPackageForkView(fork: CommunityForkListRow): PackageForkView {
	return {
		id: fork.forkId,
		name: `@${fork.ownerSlug}/${fork.kodyId}`,
		href: routes.communityPackage.href({
			username: fork.ownerSlug,
			kodyId: fork.kodyId,
		}),
		description: fork.description,
		isPrivate: fork.isPrivate,
		createdAt: fork.createdAt,
		ownerSlug: fork.ownerSlug,
		ownerDisplayName: fork.ownerDisplayName,
		ownerAvatarUrl: buildOrgAvatarUrl({
			slug: fork.ownerSlug,
			avatarKey: fork.ownerAvatarKey,
		}),
		iconUrl: resolvePackageListIconUrl({
			username: fork.ownerSlug,
			kodyId: fork.kodyId,
			listingId: null,
			listingIconCommit: null,
			publishedCommit: fork.publishedCommit,
		}),
	}
}

/**
 * Forks of a listing the viewer may see: every public fork plus the private
 * ones they can read. `total` uses the same rule, so it matches the Forks
 * count on the package page.
 */
export async function loadVisibleCommunityForks(input: {
	env: Env
	listingId: string
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	limit?: number
}): Promise<{ forks: Array<PackageForkView>; total: number }> {
	const limit = input.limit ?? packageForksPageLimit
	const [publicForks, publicCounts, privateForks] = await Promise.all([
		listPublicCommunityForks(input.env.APP_DB, {
			listingId: input.listingId,
			limit,
		}),
		countCommunityForksByListingIds(input.env.APP_DB, [input.listingId]),
		// Fail closed to public forks only if the private lookup errors.
		loadViewerPrivateCommunityForks(input).catch((error: unknown) => {
			console.warn(
				'community-forks-private-lookup-failed',
				input.listingId,
				error,
			)
			return []
		}),
	])
	const forks = [...privateForks, ...publicForks]
		.sort(compareForksNewestFirst)
		.slice(0, limit)
		.map(toPackageForkView)
	return {
		forks,
		total: (publicCounts[input.listingId] ?? 0) + privateForks.length,
	}
}
