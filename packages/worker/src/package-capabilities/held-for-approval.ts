import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { servingCommitForSource } from '#worker/repo/serving-commit.ts'

export type HeldForApproval = {
	/** The approved commit everyone still runs. */
	servingCommit: string
	/** The latest publish, built but waiting for its capability approval. */
	heldCommit: string
}

/**
 * Set when an internet-visible app's latest publish asks for more
 * capabilities than the approved version, so everyone (members, the owner
 * and anonymous visitors) stays on the serving commit until the owner
 * approves it (ADR 0069). Null otherwise.
 */
export async function loadHeldForApproval(input: {
	env: Env
	packageId: string
	ownerUserId: string
}): Promise<HeldForApproval | null> {
	const db = input.env.APP_DB
	const savedPackage = await getSavedPackageById(db, {
		userId: input.ownerUserId,
		packageId: input.packageId,
	})
	if (!savedPackage?.hasApp || !savedPackage.isInternetVisible) return null
	const source = await getEntitySourceById(db, savedPackage.sourceId)
	if (!source?.held_commit || source.held_commit !== source.published_commit) {
		return null
	}
	const servingCommit = servingCommitForSource(source)
	if (!servingCommit || servingCommit === source.held_commit) return null
	return { servingCommit, heldCommit: source.held_commit }
}
