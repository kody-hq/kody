import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { assertNever, reportLaneError } from '#worker/scheduled/lane-failure.ts'

export const guestPurgeBatchSize = 10

export type GuestPurgeFailure =
	| { kind: 'account_delete_failed'; error: unknown }
	| { kind: 'guest_row_delete_failed'; error: unknown }

/** Decides how one failed guest is counted and reported. */
export function mapGuestPurgeFailure(failure: GuestPurgeFailure) {
	switch (failure.kind) {
		case 'account_delete_failed':
		case 'guest_row_delete_failed':
			return { countAsFailed: true, logEvent: 'guest_account_purge_failed' }
		default:
			return assertNever(failure, 'guest purge failure')
	}
}

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
	const rows = await withDeadline(
		{ label: 'guest_purge.list', timeoutMs: outboundTimeoutMs.d1 },
		() =>
			db
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
				.bind(now, input.batchSize ?? guestPurgeBatchSize)
				.all<{
					id: number
					stable_user_id: string
					personal_org_id: string | null
					username: string
					email: string
					guest_created_at: string
				}>(),
	)
	const result: GuestPurgeResult = {
		scanned: rows.results?.length ?? 0,
		purged: 0,
		failed: 0,
	}
	for (const row of rows.results ?? []) {
		const failure = await purgeGuest(input.env, row)
		if (!failure) {
			result.purged += 1
			continue
		}
		const mapped = mapGuestPurgeFailure(failure)
		if (mapped.countAsFailed) result.failed += 1
		reportLaneError('error', mapped.logEvent, { error: failure.error })
	}
	return result
}

async function purgeGuest(
	env: Env,
	row: {
		id: number
		stable_user_id: string
		personal_org_id: string | null
		username: string
		email: string
		guest_created_at: string
	},
): Promise<GuestPurgeFailure | null> {
	try {
		await deleteUserAccount({
			env,
			dbUserId: row.id,
			mcpUserId: personalOrgIdFromUserRow(row),
			personUserId: row.stable_user_id,
		})
	} catch (error) {
		return { kind: 'account_delete_failed', error }
	}
	try {
		await withDeadline(
			{
				label: 'guest_purge.delete_guest_row',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				env.APP_DB.prepare(`DELETE FROM guest_accounts WHERE person_id = ?`)
					.bind(row.stable_user_id)
					.run(),
		)
	} catch (error) {
		return { kind: 'guest_row_delete_failed', error }
	}
	scheduleUserDeletedEvent({
		env,
		user: {
			id: row.stable_user_id,
			username: row.username,
			email: row.email,
		},
		createdAt: row.guest_created_at,
	})
	await logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'guest_account_purged',
		result: 'success',
		reason: 'guest_hold_ended',
	})
	return null
}
