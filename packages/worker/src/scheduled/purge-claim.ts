import * as Sentry from '@sentry/cloudflare'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { reportLaneError } from '#worker/scheduled/lane-failure.ts'

/**
 * Purge-lane claims on `users` and `orgs` rows. A pass claims an item with a
 * short lease and renews it after each completed step, so a pass that dies
 * frees the item quickly. A failure keeps the claim behind a longer fence and
 * counts the attempt; the failure that reaches `purgeClaimMaxAttempts` blocks
 * the item and no lane claims it again.
 */
export const purgeClaimLeaseMs = 15 * 60_000
export const purgeClaimFailureFenceMs = 24 * 60 * 60_000
export const purgeClaimMaxAttempts = 5
/**
 * A `deleting_at` stamped outside the purge lanes (an account deletion that
 * may still be running) holds the row this long. Rows a lane has claimed
 * (`purge_claim_holder` set) follow their lease and failure fence instead.
 */
export const purgeForeignDeletingAtGraceMs = 6 * 60 * 60_000

/**
 * Row condition for a claimable item: not blocked and no live lease or
 * failure fence. Binds the current time.
 */
export const purgeClaimFreeSql = `purge_blocked_at IS NULL
	AND (purge_claim_until IS NULL OR datetime(purge_claim_until) <= datetime(?))`

/** `SET` fragment for a new claim. Binds the holder and the lease end. */
export const purgeClaimSetSql = 'purge_claim_holder = ?, purge_claim_until = ?'

export type PurgeClaim = { holder: string; until: string }

export type PurgeClaimRow =
	| { table: 'users'; column: 'id'; value: number }
	| { table: 'users'; column: 'stable_user_id'; value: string }
	| { table: 'orgs'; column: 'id'; value: string }

export class PurgeClaimLostError extends Error {
	constructor(row: PurgeClaimRow) {
		super(`purge_claim_lost:${row.table}:${row.value}`)
		this.name = 'PurgeClaimLostError'
	}
}

export function newPurgeClaim(now: Date): PurgeClaim {
	return {
		holder: crypto.randomUUID(),
		until: new Date(now.getTime() + purgeClaimLeaseMs).toISOString(),
	}
}

/** Lane clock: the pass's `now` advanced by the wall time since `startedMs`. */
export function purgeClaimClock(now: Date, startedMs: number) {
	return () => new Date(now.getTime() + (Date.now() - startedMs))
}

/**
 * Extend a held lease to `now` plus one lease. Throws
 * {@link PurgeClaimLostError} when another pass took the item after this
 * lease expired, so the stale pass stops before its next step.
 */
export async function renewPurgeClaim(
	db: D1Database,
	input: { row: PurgeClaimRow; holder: string; now: Date },
) {
	const { table, column, value } = input.row
	const result = await runD1WithRetry(() =>
		withDeadline(
			{ label: 'purge_claim.renew', timeoutMs: outboundTimeoutMs.d1 },
			() =>
				db
					.prepare(
						`UPDATE ${table} SET purge_claim_until = ?
						WHERE ${column} = ? AND purge_claim_holder = ? AND purge_blocked_at IS NULL`,
					)
					.bind(
						new Date(input.now.getTime() + purgeClaimLeaseMs).toISOString(),
						value,
						input.holder,
					)
					.run(),
		),
	)
	if ((result.meta.changes ?? 0) !== 1) throw new PurgeClaimLostError(input.row)
}

/**
 * Count a failed attempt on a held claim. With `fence` the claim is kept
 * until the failure fence ends; without it the claim is released while the
 * count is kept. Returns `blocked: true` only for the failure that reached
 * the attempt limit, and null when this pass no longer holds the claim.
 */
export async function recordPurgeClaimFailure(
	db: D1Database,
	input: { row: PurgeClaimRow; holder: string; now: Date; fence: boolean },
): Promise<{ attempts: number; blocked: boolean } | null> {
	const { table, column, value } = input.row
	const fenceUntil = input.fence
		? new Date(input.now.getTime() + purgeClaimFailureFenceMs).toISOString()
		: null
	const updated = await runD1WithRetry(() =>
		withDeadline(
			{ label: 'purge_claim.record_failure', timeoutMs: outboundTimeoutMs.d1 },
			() =>
				db
					.prepare(
						`UPDATE ${table}
						SET purge_attempts = purge_attempts + 1,
							purge_claim_holder = CASE WHEN ? IS NULL THEN NULL ELSE purge_claim_holder END,
							purge_claim_until = ?,
							purge_blocked_at = CASE WHEN purge_attempts + 1 >= ? THEN ? END
						WHERE ${column} = ? AND purge_claim_holder = ? AND purge_blocked_at IS NULL
						RETURNING purge_attempts, purge_blocked_at`,
					)
					.bind(
						fenceUntil,
						fenceUntil,
						purgeClaimMaxAttempts,
						input.now.toISOString(),
						value,
						input.holder,
					)
					.first<{
						purge_attempts: number
						purge_blocked_at: string | null
					}>(),
		),
	)
	if (!updated) return null
	return {
		attempts: updated.purge_attempts,
		blocked: updated.purge_blocked_at != null,
	}
}

export type PurgeBlockedItem = {
	lane: string
	kind: 'org' | 'user'
	id: string
	attempts: number
	/** Already redacted by the lane. */
	lastFailure: string
}

/**
 * Record a freshly blocked item: one `purge.blocked` audit row and one Sentry
 * event. Sink failures are reported and never thrown.
 */
export async function reportPurgeBlocked(
	env: Env,
	item: PurgeBlockedItem,
	now: Date,
) {
	const details = {
		kind: item.kind,
		id: item.id,
		attempts: item.attempts,
		lastFailure: item.lastFailure,
		lane: item.lane,
	}
	reportLaneError('error', 'purge_blocked', details)
	try {
		await logOrgAuditEvent({
			env,
			orgId: item.id,
			action: 'purge.blocked',
			result: 'failure',
			resourceType: item.kind,
			resourceId: item.id,
			details,
			createdAt: now.toISOString(),
		})
	} catch (error) {
		reportLaneError('warn', 'purge_blocked_audit_failed', {
			lane: item.lane,
			kind: item.kind,
			id: item.id,
			error,
		})
	}
	try {
		if (!Sentry.isInitialized()) return
		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('scheduled.lane', item.lane)
			scope.setFingerprint(['purge-blocked', item.lane, item.id])
			scope.setContext('purge_blocked', details)
			Sentry.captureMessage(
				`Purge blocked ${item.kind} ${item.id} after ${item.attempts} failed attempts.`,
			)
		})
	} catch (error) {
		reportLaneError('warn', 'purge_blocked_sentry_failed', {
			lane: item.lane,
			id: item.id,
			error,
		})
	}
}

/**
 * Count a lane failure and report the item when this failure blocks it. A
 * failed write is reported and not thrown, so the batch continues.
 */
export async function settlePurgeClaimFailure(
	env: Env,
	input: {
		row: PurgeClaimRow
		holder: string
		now: Date
		fence: boolean
		item: Omit<PurgeBlockedItem, 'attempts'>
	},
) {
	try {
		const recorded = await recordPurgeClaimFailure(env.APP_DB, input)
		if (recorded?.blocked) {
			await reportPurgeBlocked(
				env,
				{ ...input.item, attempts: recorded.attempts },
				input.now,
			)
		}
		return recorded
	} catch (error) {
		reportLaneError('warn', 'purge_claim_failure_record_failed', {
			lane: input.item.lane,
			kind: input.item.kind,
			id: input.item.id,
			error,
		})
		return null
	}
}
