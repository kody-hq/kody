import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { liveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { clearPackageOwnedStorageBucket } from './service.ts'

const packageStoragePrefix = 'package:'
const canonicalPackageIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const orphanedPackageStorageMaxLimit = 100

export type OrphanedPackageStorageBucket = {
	userId: string
	storageId: string
	packageId: string
	estimatedBytes: number | null
}

type OrphanedPackageStorageRow = {
	user_id: string
	storage_id: string
	estimated_bytes: number | null
}

/**
 * Live `package:<uuid>` buckets whose package id has no `saved_packages` row
 * (soft-deleted rows count as present) and no community fork reserving it.
 * Only canonical lowercase UUID ids are considered, so an id that would need
 * encoding is never matched against the wrong package.
 */
export async function listOrphanedPackageStorageBuckets(
	db: D1Database,
	options: { limit?: number } = {},
): Promise<Array<OrphanedPackageStorageBucket>> {
	const limit = Math.min(
		Math.max(options.limit ?? orphanedPackageStorageMaxLimit, 1),
		orphanedPackageStorageMaxLimit,
	)
	const { results } = await db
		.prepare(
			`SELECT b.user_id, b.storage_id, b.estimated_bytes
			FROM user_storage_buckets b
			WHERE b.storage_id LIKE 'package:%'
				AND length(b.storage_id) = 44
				AND ${liveDeletedAtSql('b')}
				AND NOT EXISTS (
					SELECT 1 FROM saved_packages p WHERE 'package:' || p.id = b.storage_id
				)
				AND NOT EXISTS (
					SELECT 1 FROM community_forks f
					WHERE 'package:' || f.forked_package_id = b.storage_id
				)
			ORDER BY b.user_id, b.storage_id
			LIMIT ?`,
		)
		.bind(limit)
		.all<OrphanedPackageStorageRow>()
	return results.flatMap((row) => {
		const packageId = row.storage_id.slice(packageStoragePrefix.length)
		if (!canonicalPackageIdPattern.test(packageId)) return []
		return [
			{
				userId: row.user_id,
				storageId: row.storage_id,
				packageId,
				estimatedBytes: row.estimated_bytes,
			},
		]
	})
}

/** Preview by default; `apply` clears each orphan's storage and inventory row. */
export async function cleanupOrphanedPackageStorageBuckets(input: {
	env: Env
	apply: boolean
	limit?: number
}): Promise<{
	applied: boolean
	clearedCount: number
	failedCount: number
	orphans: Array<OrphanedPackageStorageBucket>
}> {
	const orphans = await listOrphanedPackageStorageBuckets(input.env.APP_DB, {
		limit: input.limit,
	})
	if (!input.apply) {
		return { applied: false, clearedCount: 0, failedCount: 0, orphans }
	}
	let clearedCount = 0
	let failedCount = 0
	for (const orphan of orphans) {
		const cleared = await clearPackageOwnedStorageBucket({
			env: input.env,
			userId: ownerIdFromStored(orphan.userId),
			packageId: orphan.packageId,
			storageId: orphan.storageId,
		})
		if (cleared) clearedCount++
		else failedCount++
	}
	return { applied: true, clearedCount, failedCount, orphans }
}
