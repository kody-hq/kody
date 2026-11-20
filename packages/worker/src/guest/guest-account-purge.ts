import { z } from 'zod'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { type Clock, systemClock } from '#worker/scheduled/retention/clock.ts'
import {
	d1All,
	d1Run,
	type RetentionContext,
} from '#worker/scheduled/retention/d1.ts'
import {
	dbIdColumn,
	timestampColumn,
} from '#worker/scheduled/retention/rows.ts'
import { traced } from '#worker/scheduled/retention/telemetry.ts'

export const guestPurgeBatchSize = 10

export type GuestPurgeResult = {
	scanned: number
	purged: number
	failed: number
}

const expiredGuestRow = z.object({
	id: dbIdColumn,
	stable_user_id: z.string().min(1),
	personal_org_id: z.string().nullable(),
	username: z.string(),
	email: z.string(),
	guest_created_at: timestampColumn,
})

type ExpiredGuestRow = z.output<typeof expiredGuestRow>

function purgeOneGuest(
	env: Env,
	ctx: RetentionContext,
	row: ExpiredGuestRow,
): Promise<void> {
	return traced(
		'retention.guest_purge.account',
		{},
		async () => {
			await deleteUserAccount({
				env,
				dbUserId: row.id,
				mcpUserId: personalOrgIdFromUserRow(row),
				personUserId: row.stable_user_id,
			})
			await d1Run(ctx, {
				operation: 'guest_purge.delete_guest_account',
				sql: `DELETE FROM guest_accounts WHERE person_id = ?`,
				bindings: [row.stable_user_id],
			})
			scheduleUserDeletedEvent({
				env,
				user: {
					id: row.stable_user_id,
					username: row.username,
					email: row.email,
				},
				createdAt: row.guest_created_at,
			})
			// Awaited so the audit row is written before the scheduled
			// invocation ends; logAuditEvent never throws.
			await logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'guest_account_purged',
				result: 'success',
				reason: 'guest_hold_ended',
			})
		},
		ctx.clock,
	)
}

/**
 * Delete guests whose seven-day read-only hold is over, through the normal
 * account-deletion path. Runs on the hourly unverified-account purge lane.
 */
export function pruneExpiredGuestAccounts(input: {
	env: Env
	now?: Date
	batchSize?: number
	clock?: Clock
	signal?: AbortSignal
}): Promise<GuestPurgeResult> {
	const clock = input.clock ?? systemClock
	const batchSize = input.batchSize ?? guestPurgeBatchSize
	return traced(
		'retention.guest_purge',
		{ 'retention.batch_size': batchSize },
		async (span) => {
			const ctx = { db: input.env.APP_DB, clock, signal: input.signal }
			const now = (input.now ?? clock.now()).toISOString()
			const rows = await d1All(ctx, {
				operation: 'guest_purge.list_expired',
				sql: `SELECT u.id, u.stable_user_id, u.personal_org_id, u.username, u.email,
				        g.created_at AS guest_created_at
				 FROM guest_accounts g
				 INNER JOIN users u ON u.stable_user_id = g.person_id
				 WHERE g.claimed_at IS NULL
				   AND g.delete_at <= ?
				   AND u.guest_expires_at IS NOT NULL
				   AND u.deleting_at IS NULL
				   AND u.deleted_at IS NULL
				 ORDER BY g.delete_at
				 LIMIT ?`,
				bindings: [now, batchSize],
				row: expiredGuestRow,
			})
			const result: GuestPurgeResult = {
				scanned: rows.length,
				purged: 0,
				failed: 0,
			}
			for (const row of rows) {
				try {
					await purgeOneGuest(input.env, ctx, row)
					result.purged += 1
				} catch (error) {
					result.failed += 1
					console.error('guest_account_purge_failed', { error })
				}
			}
			span.setAttribute('retention.scanned', result.scanned)
			span.setAttribute('retention.purged', result.purged)
			span.setAttribute('retention.failed', result.failed)
			return result
		},
		clock,
	)
}
