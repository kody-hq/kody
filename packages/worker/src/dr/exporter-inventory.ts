import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { JobsStore } from '@kody-internal/shared/jobs/store.ts'
import { listPlatformStorageBuckets } from '#worker/storage-buckets/service.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type StorageInventoryEntry = {
	userId: OwnerId
	storageId: string
	identity: string
}

export type ArtifactInventoryEntry = {
	sourceId: string
	userId: string
	entityKind: string
	entityId: string
	publishedCommit: string
}

export async function listPlatformOwnerInventory(
	db: D1Database,
): Promise<Array<OwnerId>> {
	const result = await db
		.prepare(
			`SELECT stable_user_id AS ownerId
			FROM users
			WHERE deleting_at IS NULL${andLiveDeletedAtSql()}
			ORDER BY stable_user_id ASC`,
		)
		.all<{ ownerId: OwnerId }>()
	return (result.results ?? []).map((row) => row.ownerId)
}

/**
 * Platform-wide StorageRunner inventory.
 *
 * Deliberate exception to per-user scoping: this operator-level DR exporter
 * iterates every user's storage ids so the sealed day can rebuild the whole
 * platform. Do not copy this pattern into user-facing read/write paths.
 */
export async function listPlatformStorageInventory(input: {
	db: D1Database
	/** Jobs-data access for job/archived-artifact storage ids (ADR 0016). */
	jobs: JobsStore
}): Promise<Array<StorageInventoryEntry>> {
	const { db, jobs } = input
	// Ad-hoc / execute buckets come from the authoritative
	// `user_storage_buckets` registry. Job and archived-artifact storage ids
	// come from the jobs worker's database.
	const [jobStorageOwners, registeredBuckets] = await Promise.all([
		jobs.listAllJobStorageOwners(),
		listPlatformStorageBuckets({ db }),
	])

	const seen = new Set<string>()
	const inventory: Array<StorageInventoryEntry> = []
	function push(userId: string, storageId: string) {
		const identity = encodeStorageIdentity(userId, storageId)
		if (seen.has(identity)) return
		seen.add(identity)
		inventory.push({ userId: userId as OwnerId, storageId, identity })
	}
	for (const row of jobStorageOwners) push(row.userId, row.storageId)
	for (const row of registeredBuckets) push(row.userId, row.storageId)
	inventory.sort((left, right) => left.identity.localeCompare(right.identity))
	return inventory
}

export async function listPlatformArtifactInventory(
	db: D1Database,
): Promise<Array<ArtifactInventoryEntry>> {
	const result = await db
		.prepare(
			`SELECT id AS sourceId, user_id AS userId, entity_kind AS entityKind,
				entity_id AS entityId, published_commit AS publishedCommit
			FROM entity_sources
			WHERE published_commit IS NOT NULL AND trim(published_commit) != ''${andLiveDeletedAtSql()}
			ORDER BY id ASC`,
		)
		.all<ArtifactInventoryEntry>()
	return result.results ?? []
}
