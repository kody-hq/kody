// soft-delete-read-filter: opt-out
import { runD1WithRetry } from '#worker/d1-retry.ts'

/**
 * Owner ids (person accounts or orgs) whose deletion has started or finished:
 * `deleting_at` or `deleted_at` is set on the org row, on the person row, or on
 * the person row whose personal org is the owner.
 *
 * Fleet scans (published-commit repair, package codemods) skip packages owned
 * by these ids. Account deletion or the purge lane owns that storage now, and
 * a scan against half-deleted storage only reports noise failures.
 *
 * Reads tombstoned rows on purpose, so this module opts out of the live
 * deleted_at read filter.
 */

// D1 caps bound parameters at 100 per statement; each id binds three times.
const ownerIdChunkSize = 30

export async function listOwnerIdsPendingDeletion(
	db: D1Database,
	ownerIds: Iterable<string>,
): Promise<Set<string>> {
	const unique = [
		...new Set([...ownerIds].map((ownerId) => ownerId.trim()).filter(Boolean)),
	]
	const pending = new Set<string>()
	for (let index = 0; index < unique.length; index += ownerIdChunkSize) {
		const chunk = unique.slice(index, index + ownerIdChunkSize)
		const placeholders = chunk.map(() => '?').join(', ')
		const { results } = await runD1WithRetry(() =>
			db
				.prepare(
					`SELECT id AS owner_id FROM orgs
					 WHERE id IN (${placeholders})
					   AND (deleting_at IS NOT NULL OR deleted_at IS NOT NULL)
					 UNION
					 SELECT stable_user_id AS owner_id FROM users
					 WHERE stable_user_id IN (${placeholders})
					   AND (deleting_at IS NOT NULL OR deleted_at IS NOT NULL)
					 UNION
					 SELECT personal_org_id AS owner_id FROM users
					 WHERE personal_org_id IN (${placeholders})
					   AND (deleting_at IS NOT NULL OR deleted_at IS NOT NULL)`,
				)
				.bind(...chunk, ...chunk, ...chunk)
				.all<{ owner_id: string | null }>(),
		)
		for (const row of results ?? []) {
			if (row.owner_id) pending.add(row.owner_id)
		}
	}
	return pending
}
