// soft-delete-read-filter: opt-out
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import {
	guestPurgeState,
	type GuestPurgeResult,
	type GuestPurgeRow,
} from '#worker/guest/guest-purge-state.ts'

export const guestPurgeBatchSize = 10

export type { GuestPurgeResult }

/**
 * Delete guests whose seven-day read-only hold is over, through the normal
 * account-deletion path. Runs on the hourly unverified-account purge lane.
 */
export async function pruneExpiredGuestAccounts(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<GuestPurgeResult> {
	const db = input.env.APP_DB
	const workflow = guestPurgeState.provide({
		actors: {
			listExpiredGuests: createAsyncLogic<
				Array<GuestPurgeRow>,
				{ now: string; batchSize: number }
			>({
				run: async ({ input: list }) => {
					const rows = await db
						.prepare(
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
						)
						.bind(list.now, list.batchSize)
						.all<GuestPurgeRow>()
					return rows.results ?? []
				},
			}),
			deleteGuestAccount: createAsyncLogic<void, GuestPurgeRow>({
				run: async ({ input: row }) => {
					await deleteUserAccount({
						env: input.env,
						dbUserId: row.id,
						mcpUserId: personalOrgIdFromUserRow(row),
						personUserId: row.stable_user_id,
					})
				},
			}),
			deleteGuestRow: createAsyncLogic<void, GuestPurgeRow>({
				run: async ({ input: row }) => {
					await db
						.prepare(`DELETE FROM guest_accounts WHERE person_id = ?`)
						.bind(row.stable_user_id)
						.run()
				},
			}),
			announceGuestPurged: createAsyncLogic<void, GuestPurgeRow>({
				run: async ({ input: row }) => {
					scheduleUserDeletedEvent({
						env: input.env,
						user: {
							id: row.stable_user_id,
							username: row.username,
							email: row.email,
						},
						createdAt: row.guest_created_at,
					})
					void logAuditEvent({
						db: auditDatabaseFromEnv(input.env),
						category: 'account',
						action: 'guest_account_purged',
						result: 'success',
						reason: 'guest_hold_ended',
					})
				},
			}),
			// Claimed guest rows outlive their users row as the claimer's OAuth
			// alias, so only unclaimed rows are orphans.
			deleteOrphanedGuestRows: createAsyncLogic<void, { now: string }>({
				run: async ({ input: sweep }) => {
					await db
						.prepare(
							`DELETE FROM guest_accounts
			 WHERE claimed_at IS NULL
			   AND delete_at <= ?
			   AND NOT EXISTS (
			     SELECT 1 FROM users u WHERE u.stable_user_id = guest_accounts.person_id
			   )`,
						)
						.bind(sweep.now)
						.run()
				},
			}),
		},
	})
	const output = await toPromise(
		createActor(workflow, {
			input: {
				now: (input.now ?? new Date()).toISOString(),
				batchSize: input.batchSize ?? guestPurgeBatchSize,
			},
		}).start(),
	)
	if (output.status === 'list_failed') throw output.error
	return output.result
}
