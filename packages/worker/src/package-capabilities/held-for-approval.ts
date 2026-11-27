import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	getEntitySourceById,
	listEntitySourcesByIds,
} from '#worker/repo/entity-sources.ts'
import { servingCommitForSource } from '#worker/repo/serving-commit.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'

export type HeldForApproval = {
	/** The approved commit everyone still runs. */
	servingCommit: string
	/** The latest publish, built but waiting for its capability approval. */
	heldCommit: string
}

/**
 * The held state a source row records, or null when its latest publish is
 * serving (or nothing serves yet). A held commit that a newer publish
 * replaced no longer waits for anything.
 */
export function heldForApprovalFromSource(
	source: Pick<
		EntitySourceRow,
		'published_commit' | 'serving_commit' | 'held_commit'
	> | null,
): HeldForApproval | null {
	if (!source?.held_commit || source.held_commit !== source.published_commit) {
		return null
	}
	const servingCommit = servingCommitForSource(source)
	if (!servingCommit || servingCommit === source.held_commit) return null
	return { servingCommit, heldCommit: source.held_commit }
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
	return heldForApprovalFromSource(
		await getEntitySourceById(db, savedPackage.sourceId),
	)
}

export type HeldForApprovalPackage = HeldForApproval & {
	packageId: string
	name: string
	kodyId: string
}

/**
 * The packages among `packages` whose latest publish is held. Only
 * internet-visible apps can hold a commit, so most accounts read nothing.
 */
export async function listHeldForApprovalPackages(
	db: D1Database,
	packages: ReadonlyArray<{
		id: string
		name: string
		kodyId: string
		sourceId: string
		hasApp: boolean
		isInternetVisible: boolean
	}>,
): Promise<Array<HeldForApprovalPackage>> {
	const apps = packages.filter((pkg) => pkg.hasApp && pkg.isInternetVisible)
	if (apps.length === 0) return []
	const sources = await listEntitySourcesByIds(
		db,
		apps.map((pkg) => pkg.sourceId),
	)
	const heldBySourceId = new Map(
		sources.map((source) => [source.id, heldForApprovalFromSource(source)]),
	)
	return apps.flatMap((pkg) => {
		const held = heldBySourceId.get(pkg.sourceId)
		return held
			? [{ ...held, packageId: pkg.id, name: pkg.name, kodyId: pkg.kodyId }]
			: []
	})
}
