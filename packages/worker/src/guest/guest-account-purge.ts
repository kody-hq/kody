// soft-delete-read-filter: opt-out (purge lane: the orphan sweep must see
// soft-deleted users rows, so it only removes rows whose account is gone)
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { softDeletePurgeRetryBackoffMs } from '#worker/orgs/purge.ts'
import {
	finishLegacyUserDeletion,
	hardDeleteLivePersonWithOrgs,
} from '#worker/orgs/hard-purge.ts'
import {
	soleOwnerWithOtherMembersReason,
	UserDeleteBlockedSoleOwnerError,
} from '#worker/orgs/soft-delete.ts'

export const guestPurgeBatchSize = 10

export type GuestPurgeResult = {
	scanned: number
	purged: number
	failed: number
}

/**
 * Delete guests whose seven-day read-only hold is over, through the normal
 * account-deletion path. Runs on the hourly unverified-account purge lane.
 * A guest whose deletion failed after it set the `deleting_at` fence is
 * retried once the fence is older than the purge retry backoff. The retry
 * restamps the fence first so concurrent passes leave it alone, then finishes
 * through `finishLegacyUserDeletion` so the personal org is purged too.
 * Permanent: current guest deletions still leave this fence, so this retry
 * stays after the legacy deletion backlog is gone.
 */
export async function pruneExpiredGuestAccounts(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<GuestPurgeResult> {
	const nowDate = input.now ?? new Date()
	const now = nowDate.toISOString()
	const retryBackoffCutoff = new Date(
		nowDate.getTime() - softDeletePurgeRetryBackoffMs,
	).toISOString()
	const db = input.env.APP_DB
	const rows = await db
		.prepare(
			`SELECT u.id, u.stable_user_id, u.personal_org_id, u.username, u.email,
			        u.deleting_at, g.created_at AS guest_created_at
			 FROM guest_accounts g
			 INNER JOIN users u ON u.stable_user_id = g.person_id
			 WHERE g.claimed_at IS NULL
			   AND g.delete_at <= ?
			   AND u.guest_expires_at IS NOT NULL
			   AND (u.deleting_at IS NULL OR datetime(u.deleting_at) < datetime(?))
			   AND u.deleted_at IS NULL
			 ORDER BY g.delete_at
			 LIMIT ?`,
		)
		.bind(now, retryBackoffCutoff, input.batchSize ?? guestPurgeBatchSize)
		.all<{
			id: number
			stable_user_id: string
			personal_org_id: string | null
			username: string
			email: string
			deleting_at: string | null
			guest_created_at: string
		}>()
	const result: GuestPurgeResult = {
		scanned: rows.results?.length ?? 0,
		purged: 0,
		failed: 0,
	}
	for (const row of rows.results ?? []) {
		try {
			if (row.deleting_at) {
				const claimed = await db
					.prepare(
						`UPDATE users SET deleting_at = ?, updated_at = ?
						 WHERE id = ? AND deleted_at IS NULL AND deleting_at = ?`,
					)
					.bind(now, now, row.id, row.deleting_at)
					.run()
				if ((claimed.meta.changes ?? 0) !== 1) continue
			}
			try {
				if (row.deleting_at) {
					await finishLegacyUserDeletion({
						env: input.env,
						dbUserId: row.id,
						stableUserId: ownerIdFromStored(row.stable_user_id),
					})
				} else {
					await hardDeleteLivePersonWithOrgs({
						env: input.env,
						dbUserId: row.id,
						personUserId: row.stable_user_id,
						personalOrgId: personalOrgIdFromUserRow(row),
					})
				}
			} catch (error) {
				if (error instanceof UserDeleteBlockedSoleOwnerError) {
					// The guest stays until another Owner is promoted or the
					// other members are removed; the next pass checks again.
					await logAuditEvent({
						db: auditDatabaseFromEnv(input.env),
						category: 'account',
						action: 'guest_account_purge_skipped',
						result: 'failure',
						reason: soleOwnerWithOtherMembersReason,
					})
				}
				// Once the users row is gone this guest cannot be selected again,
				// so a later step failing (a tombstoned personal org is left for
				// the org lane) must not skip the event, audit, and guest row.
				const stillThere = await runD1WithRetry(() =>
					db
						.prepare(`SELECT 1 AS present FROM users WHERE id = ?`)
						.bind(row.id)
						.first<{ present: number }>(),
				)
				if (stillThere) throw error
				console.warn('guest_account_purge_cleanup_incomplete', { error })
			}
			// The account is gone, so the deletion event and audit go out even
			// if the guest_accounts delete fails; the sweep below removes it.
			scheduleUserDeletedEvent({
				env: input.env,
				user: {
					id: row.stable_user_id,
					username: row.username,
					email: row.email,
				},
				createdAt: row.guest_created_at,
			})
			await logAuditEvent({
				db: auditDatabaseFromEnv(input.env),
				category: 'account',
				action: 'guest_account_purged',
				result: 'success',
				reason: 'guest_hold_ended',
			})
			await runD1WithRetry(() =>
				db
					.prepare(`DELETE FROM guest_accounts WHERE person_id = ?`)
					.bind(row.stable_user_id)
					.run(),
			)
			result.purged += 1
		} catch (error) {
			result.failed += 1
			console.error('guest_account_purge_failed', { error })
		}
	}
	// Expired guest rows whose account is already gone (a delete above failed
	// after its account deletion) cannot be selected again, so remove them.
	await runD1WithRetry(() =>
		db
			.prepare(
				`DELETE FROM guest_accounts
				 WHERE claimed_at IS NULL
				   AND delete_at <= ?
				   AND NOT EXISTS (
				     SELECT 1 FROM users u WHERE u.stable_user_id = guest_accounts.person_id
				   )`,
			)
			.bind(now)
			.run(),
	).catch((error: unknown) => {
		// Orphaned guest rows stay until a later sweep succeeds; they block
		// nothing because their account is already gone.
		console.warn('guest_account_orphan_sweep_failed', { error })
	})
	return result
}
