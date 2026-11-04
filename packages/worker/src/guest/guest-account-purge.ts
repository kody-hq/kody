import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'

export const guestPurgeBatchSize = 10

export type GuestPurgeResult = {
	scanned: number
	purged: number
	failed: number
}

/**
 * Delete guests whose seven-day read-only hold is over, through the normal
 * account-deletion path. Runs on the hourly unverified-account purge lane.
 */
export async function pruneExpiredGuestAccounts(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<GuestPurgeResult> {
	const now = (input.now ?? new Date()).toISOString()
	const db = input.env.APP_DB
	const rows = await db
		.prepare(
			`SELECT u.id, u.stable_user_id, u.personal_org_id
			 FROM guest_accounts g
			 INNER JOIN users u ON u.stable_user_id = g.person_id
			 WHERE g.claimed_at IS NULL
			   AND g.delete_at <= ?
			   AND u.guest_expires_at IS NOT NULL
			   AND u.deleting_at IS NULL
			   AND u.deleted_at IS NULL
			 ORDER BY g.delete_at
			 LIMIT ?`,
		)
		.bind(now, input.batchSize ?? guestPurgeBatchSize)
		.all<{
			id: number
			stable_user_id: string
			personal_org_id: string | null
		}>()
	const result: GuestPurgeResult = {
		scanned: rows.results?.length ?? 0,
		purged: 0,
		failed: 0,
	}
	for (const row of rows.results ?? []) {
		try {
			await deleteUserAccount({
				env: input.env,
				dbUserId: row.id,
				mcpUserId: personalOrgIdFromUserRow(row),
				personUserId: row.stable_user_id,
			})
			await db
				.prepare(`DELETE FROM guest_accounts WHERE person_id = ?`)
				.bind(row.stable_user_id)
				.run()
			result.purged += 1
			void logAuditEvent({
				db: auditDatabaseFromEnv(input.env),
				category: 'account',
				action: 'guest_account_purged',
				result: 'success',
				reason: 'guest_hold_ended',
			})
		} catch (error) {
			result.failed += 1
			console.error('guest_account_purge_failed', { error })
		}
	}
	return result
}
