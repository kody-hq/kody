import { memoizeReadPerRequest } from '#worker/request-context.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * A personal (signup) organization is the org recorded on a live person's
 * `users.personal_org_id` (fallback: `stable_user_id` when the column is blank).
 *
 * Do not use founding membership (`org_id = user_id`) alone. Migration 0099
 * soft-deletes that row for former platform orgs (for example `@kody`) and
 * deletes the platform `users` row, but leaves the soft-deleted membership.
 * Counting that membership would hide team identity editing on ordinary orgs
 * that used to be platform accounts.
 */
export async function isPersonalOrg(db: D1Database, orgId: string) {
	return await memoizeReadPerRequest({
		key: `org:personal:${orgId}`,
		load: () => readIsPersonalOrg(db, orgId),
	})
}

async function readIsPersonalOrg(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok
			 FROM users
			 WHERE (
			 	(personal_org_id IS NOT NULL AND TRIM(personal_org_id) != '' AND personal_org_id = ?)
			 	OR ((personal_org_id IS NULL OR TRIM(personal_org_id) = '') AND stable_user_id = ?)
			 )${andLiveDeletedAtSql()}`,
		)
		.bind(orgId, orgId)
		.first<{ ok: number }>()
	return Boolean(row)
}
