import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getActiveCommunityForkClaim } from '#worker/community/fork-claims.ts'
import { findExistingCommunityFork } from '#worker/community/service.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getPackageScopeByUserId } from '#worker/package-registry/user-scope.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import { type CommunityForkState } from '#universal/community-public-types.ts'

/**
 * The viewer's fork of a listing in the org one-click install writes to (the
 * picked org, else the personal org): an existing fork, one still being
 * created, or none.
 */
export async function loadWebsiteCommunityForkState(input: {
	env: Env
	user: AuthenticatedAppUser
	listingId: string
	/** Already authorized install org; omitted reads the personal org. */
	ownerId?: OwnerId
}): Promise<CommunityForkState> {
	const { env, user, listingId } = input
	const ownerId = input.ownerId ?? personalOrgIdForPerson(user.mcpUser)
	const [claim, fork] = await Promise.all([
		getActiveCommunityForkClaim(env.APP_DB, {
			ownerIds: [ownerId],
			listingId,
		}),
		findExistingCommunityFork({ env, userId: ownerId, listingId }),
	])
	if (fork) {
		const saved = await getSavedPackageById(env.APP_DB, {
			userId: ownerId,
			packageId: fork.forkedPackageId,
		})
		// Install writes the fork row before it publishes; while the claim is
		// still held the fork is not done yet.
		if (!saved && claim) {
			return { state: 'in_progress', startedAt: claim.startedAt }
		}
		const scope = await getPackageScopeByUserId(env.APP_DB, ownerId)
		const targetName = saved?.name ?? `@${scope}/${fork.targetKodyId}`
		return {
			state: saved ? 'installed' : 'adaptation_required',
			targetName,
			href: getCommunityPackageHrefFromName(targetName) ?? '/account/packages',
		}
	}
	if (claim) return { state: 'in_progress', startedAt: claim.startedAt }
	return { state: 'none' }
}
