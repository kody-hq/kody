import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { servingCommitForSource } from '#worker/repo/serving-commit.ts'
import { getServedPackageCapabilityApproval } from './capability-approvals-repo.ts'

export type PublicVisitorsHeldBack = {
	/** The approved commit anonymous visitors still run. */
	publicCommit: string
	/** The serving commit that waits for its capability approval. */
	servingCommit: string
}

/**
 * Set when an internet-visible app serves a commit whose capability set is
 * wider than the approved one, so anonymous visitors stay on the previous
 * approved commit until the owner approves (ADR 0069). Null otherwise,
 * including an app never approved for the public.
 */
export async function loadPublicVisitorsHeldBack(input: {
	env: Env
	packageId: string
	ownerUserId: string
}): Promise<PublicVisitorsHeldBack | null> {
	const db = input.env.APP_DB
	const savedPackage = await getSavedPackageById(db, {
		userId: input.ownerUserId,
		packageId: input.packageId,
	})
	if (!savedPackage?.hasApp || !savedPackage.isInternetVisible) return null
	const [source, served] = await Promise.all([
		getEntitySourceById(db, savedPackage.sourceId),
		getServedPackageCapabilityApproval(db, {
			packageId: savedPackage.id,
			ownerUserId: savedPackage.userId,
			sourceId: savedPackage.sourceId,
		}),
	])
	const servingCommit = source ? servingCommitForSource(source) : null
	if (!served || !servingCommit || served.publishedCommit === servingCommit) {
		return null
	}
	return { publicCommit: served.publishedCommit, servingCommit }
}
