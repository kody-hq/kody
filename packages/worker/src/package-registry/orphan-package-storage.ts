/**
 * soft-delete-read-filter: opt-out — orphan detection counts soft-deleted
 * packages as present, so these reads include them on purpose.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { liveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { clearPackageOwnedStorageBucket } from './service.ts'

const packageStoragePrefix = 'package:'

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
				AND substr(b.storage_id, 9) NOT GLOB '*[^-0-9a-f]*'
				AND length(replace(substr(b.storage_id, 9), '-', '')) = 32
				AND substr(b.storage_id, 17, 1) = '-'
				AND substr(b.storage_id, 22, 1) = '-'
				AND substr(b.storage_id, 27, 1) = '-'
				AND substr(b.storage_id, 32, 1) = '-'
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
	return results.map((row) => ({
		userId: row.user_id,
		storageId: row.storage_id,
		packageId: row.storage_id.slice(packageStoragePrefix.length),
		estimatedBytes: row.estimated_bytes,
	}))
}

async function packageIdIsClaimed(db: D1Database, packageId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS claimed FROM saved_packages WHERE id = ?
			UNION ALL
			SELECT 1 AS claimed FROM community_forks WHERE forked_package_id = ?
			LIMIT 1`,
		)
		.bind(packageId, packageId)
		.first<{ claimed: number }>()
	return row !== null
}

/**
 * Preview by default; `apply` clears each orphan's storage and inventory row.
 * Each id is rechecked right before its clear, since `packageSave` can create
 * a package with a caller-chosen `package_id`; claimed ids are skipped.
 */
export async function cleanupOrphanedPackageStorageBuckets(input: {
	env: Env
	apply: boolean
	limit?: number
}): Promise<{
	applied: boolean
	clearedCount: number
	failedCount: number
	skippedCount: number
	orphans: Array<OrphanedPackageStorageBucket>
}> {
	const orphans = await listOrphanedPackageStorageBuckets(input.env.APP_DB, {
		limit: input.limit,
	})
	if (!input.apply) {
		return {
			applied: false,
			clearedCount: 0,
			failedCount: 0,
			skippedCount: 0,
			orphans,
		}
	}
	let clearedCount = 0
	let failedCount = 0
	let skippedCount = 0
	for (const orphan of orphans) {
		if (await packageIdIsClaimed(input.env.APP_DB, orphan.packageId)) {
			skippedCount++
			continue
		}
		const cleared = await clearPackageOwnedStorageBucket({
			env: input.env,
			userId: ownerIdFromStored(orphan.userId),
			packageId: orphan.packageId,
			storageId: orphan.storageId,
		})
		if (cleared) clearedCount++
		else failedCount++
	}
	return { applied: true, clearedCount, failedCount, skippedCount, orphans }
}
