import { Cause, DateTime, Effect, Schema } from 'effect'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { deleteUserAccountEffect } from '#app/account-deletion.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { AuditLog } from '#worker/effect/audit.ts'
import { D1, sql } from '#worker/effect/d1.ts'
import { runSlicePromise } from '#worker/effect/slice.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

export const guestPurgeBatchSize = 10

export type GuestPurgeResult = {
	scanned: number
	purged: number
	failed: number
}

const ExpiredGuestRow = Schema.Struct({
	id: Schema.Number,
	stable_user_id: Schema.String,
	personal_org_id: Schema.NullOr(Schema.String),
	username: Schema.String,
	email: Schema.String,
	guest_created_at: Schema.String,
})
type ExpiredGuestRow = typeof ExpiredGuestRow.Type

/** Deletes one expired guest, its guest row, and announces the deletion. */
const purgeGuest = Effect.fn('GuestPurge.purgeGuest')(function* (
	row: ExpiredGuestRow,
) {
	const env = yield* WorkerEnv
	const db = yield* D1
	const audit = yield* AuditLog
	yield* deleteUserAccountEffect({
		dbUserId: row.id,
		mcpUserId: personalOrgIdFromUserRow(row),
		personUserId: row.stable_user_id,
	})
	yield* db.run(
		'guest_purge.delete_guest_row',
		sql(`DELETE FROM guest_accounts WHERE person_id = ?`, row.stable_user_id),
	)
	yield* Effect.sync(() =>
		scheduleUserDeletedEvent({
			env,
			user: { id: row.stable_user_id, username: row.username, email: row.email },
			createdAt: row.guest_created_at,
		}),
	)
	yield* audit.record({
		category: 'account',
		action: 'guest_account_purged',
		result: 'success',
		reason: 'guest_hold_ended',
	}).pipe(
		Effect.catchTag('OutboundCallError', (error) =>
			Effect.logWarning('guest_account_purge_audit_failed', { error: error.cause }),
		),
	)
})

/**
 * Delete guests whose seven-day read-only hold is over, through the normal
 * account-deletion path. Runs on the hourly unverified-account purge lane.
 */
export const pruneExpiredGuestAccountsEffect = Effect.fn('GuestPurge.prune')(
	function* (input: { readonly now?: Date; readonly batchSize?: number }) {
		const db = yield* D1
		const now = input.now
			? input.now.toISOString()
			: DateTime.formatIso(yield* DateTime.now)
		const rows = yield* db.all(
			'guest_purge.expired',
			ExpiredGuestRow,
			sql(
				`SELECT u.id, u.stable_user_id, u.personal_org_id, u.username, u.email,
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
				now,
				input.batchSize ?? guestPurgeBatchSize,
			),
		)
		const result: GuestPurgeResult = { scanned: rows.length, purged: 0, failed: 0 }
		for (const row of rows) {
			yield* purgeGuest(row).pipe(
				Effect.matchCauseEffect({
					onSuccess: () => Effect.sync(() => (result.purged += 1)),
					onFailure: (cause) =>
						Effect.sync(() => (result.failed += 1)).pipe(
							Effect.andThen(
								Effect.logError('guest_account_purge_failed', {
									error: Cause.squash(cause),
								}),
							),
						),
				}),
			)
		}
		yield* Effect.logDebug('guest purge pass finished', result)
		return result
	},
)

export function pruneExpiredGuestAccounts(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<GuestPurgeResult> {
	const { env, ...rest } = input
	return runSlicePromise(env, pruneExpiredGuestAccountsEffect(rest))
}
