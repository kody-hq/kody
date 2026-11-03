import {
	classifyForkListingRelation,
	type ForkListingRelation,
} from '#universal/community-listing-ahead.ts'
import { listingPinIsAncestorOfForkTip } from '#worker/community/fork-listing-ancestry.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import type { SavedPackageWithCommunityProvenanceRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

export function needsForkListingAncestry(input: {
	originCommit: string | null | undefined
	listingPinnedCommit: string | null | undefined
}) {
	return classifyForkListingRelation(input) === 'ahead'
}

/**
 * Compare two origin-repo SHAs: the listing pin and the fork's last absorbed
 * origin commit. Walks the listing's Artifacts repo, not the fork's copy.
 */
export async function resolveListingPinAncestry(input: {
	env: Env
	listingId: string
	listingPinnedCommit: string
	originCommit: string
}): Promise<boolean | null> {
	try {
		return await listingPinIsAncestorOfForkTip({
			env: input.env,
			listingPinnedCommit: input.listingPinnedCommit,
			forkTip: input.originCommit,
			async resolveOriginRepoId() {
				const listing = await getCommunityListingById(input.env.APP_DB, {
					listingId: input.listingId,
					includeDelisted: false,
				})
				if (!listing) return null
				const source = await getEntitySourceById(
					input.env.APP_DB,
					listing.sourceId,
				)
				return source?.repo_id ?? null
			},
		})
	} catch {
		return null
	}
}

export async function applySavedPackageForkListingAncestry(input: {
	env: Env
	records: Array<SavedPackageWithCommunityProvenanceRecord>
}): Promise<Array<SavedPackageWithCommunityProvenanceRecord>> {
	if (input.records.length === 0) return input.records
	const ancestryByKey = new Map<string, Promise<boolean | null>>()
	function ancestryFor(record: SavedPackageWithCommunityProvenanceRecord) {
		if (
			record.listingCurrent !== true ||
			record.sourceListingId == null ||
			record.originCommit == null ||
			record.listingPinnedCommit == null ||
			!needsForkListingAncestry(record)
		) {
			return null
		}
		const key = `${record.sourceListingId}:${record.originCommit}:${record.listingPinnedCommit}`
		const existing = ancestryByKey.get(key)
		if (existing) return existing
		const pending = resolveListingPinAncestry({
			env: input.env,
			listingId: record.sourceListingId,
			listingPinnedCommit: record.listingPinnedCommit,
			originCommit: record.originCommit,
		})
		ancestryByKey.set(key, pending)
		return pending
	}
	return Promise.all(
		input.records.map(async (record) => {
			const pending = ancestryFor(record)
			if (pending == null) {
				return withForkListingRelation(
					record,
					classifyForkListingRelation(record),
				)
			}
			return withForkListingRelation(
				record,
				classifyForkListingRelation({
					originCommit: record.originCommit,
					listingPinnedCommit: record.listingPinnedCommit,
					listingPinIsAncestorOfForkTip: await pending,
				}),
			)
		}),
	)
}

function withForkListingRelation(
	record: SavedPackageWithCommunityProvenanceRecord,
	relation: ForkListingRelation | null,
): SavedPackageWithCommunityProvenanceRecord {
	if (record.listingCurrent == null) return record
	if (record.listingCurrent !== true) {
		return {
			...record,
			listingAhead: false,
			forkListingRelation: null,
		}
	}
	return {
		...record,
		listingAhead: relation === 'outdated',
		forkListingRelation: relation,
	}
}
