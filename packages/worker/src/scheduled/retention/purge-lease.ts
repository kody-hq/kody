import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import type { Clock } from './clock.ts'
import { d1First, d1Run, type RetentionContext } from './d1.ts'

/** A purge claim holds its row this long, renewed after each completed step. */
export const purgeClaimLeaseMs = 15 * 60 * 1000
/** A failed attempt keeps its claim as the retry fence for this long. */
export const purgeFailureFenceMs = 24 * 60 * 60 * 1000
/** The failed attempt that blocks a row from every purge lane. */
export const purgeMaxFailedAttempts = 5

/**
 * Rows a purge pass may claim: not blocked, no live lease or failure fence,
 * and a `deleting_at` written by something other than a purge claim (an
 * account deletion in flight, a pre-lease claim) older than the lane's
 * unleased-fence cutoff. Bindings: `[nowIso, unleasedFenceCutoff]`.
 * Lease expiries are only written as `toISOString()` values, so they compare
 * as text at millisecond precision (`datetime()` would round to seconds).
 */
export const purgeClaimableSql = `purge_failed_attempts < ${purgeMaxFailedAttempts}
	AND (purge_lease_expires_at IS NULL OR purge_lease_expires_at <= ?)
	AND (deleting_at IS NULL OR purge_lease_expires_at IS NOT NULL OR datetime(deleting_at) < datetime(?))`

export type PurgeLeaseRow = {
	table: 'orgs' | 'users'
	idColumn: 'id' | 'stable_user_id'
	id: string | number
}

export function purgeLeaseExpiresAt(clock: Clock, ms = purgeClaimLeaseMs) {
	return new Date(clock.nowMs() + ms).toISOString()
}

export class PurgeLeaseLostError extends Error {
	constructor(table: PurgeLeaseRow['table']) {
		super(`purge_lease_lost:${table}`)
		this.name = 'PurgeLeaseLostError'
	}
}

/**
 * The claim a pass holds on one row. The expiry it last wrote is the
 * ownership token: a renewal or failure write only lands while it matches,
 * so a pass whose lease expired and was taken over cannot touch the row.
 */
export type PurgeLease = {
	readonly row: PurgeLeaseRow
	/** Extends the lease to now + 15 minutes; throws when it was taken over. */
	renew(): Promise<void>
	/**
	 * Fences the row for 24 hours and counts the failed attempt. Returns the
	 * new attempt count, or null when the lease was already taken over.
	 */
	recordFailedAttempt(): Promise<number | null>
}

export function holdPurgeLease(
	ctx: RetentionContext,
	row: PurgeLeaseRow,
	expiresAt: string,
): PurgeLease {
	let token = expiresAt
	const where = `${row.idColumn} = ? AND purge_lease_expires_at = ?`
	return {
		row,
		async renew() {
			const next = purgeLeaseExpiresAt(ctx.clock)
			const changes = await d1Run(ctx, {
				operation: `purge_lease.renew_${row.table}`,
				sql: `UPDATE ${row.table} SET purge_lease_expires_at = ? WHERE ${where}`,
				bindings: [next, row.id, token],
			})
			if (changes !== 1) throw new PurgeLeaseLostError(row.table)
			token = next
		},
		async recordFailedAttempt() {
			const fence = purgeLeaseExpiresAt(ctx.clock, purgeFailureFenceMs)
			const changes = await d1Run(ctx, {
				operation: `purge_lease.record_failure_${row.table}`,
				sql: `UPDATE ${row.table}
					SET purge_failed_attempts = purge_failed_attempts + 1,
						purge_lease_expires_at = ?
					WHERE ${where}`,
				bindings: [fence, row.id, token],
			})
			if (changes !== 1) return null
			token = fence
			const counted = await d1First(ctx, {
				operation: `purge_lease.failed_attempts_${row.table}`,
				sql: `SELECT purge_failed_attempts AS attempts FROM ${row.table}
					WHERE ${row.idColumn} = ?`,
				bindings: [row.id],
				row: z.object({ attempts: z.number().int() }),
			})
			return counted?.attempts ?? null
		},
	}
}

export class PurgeBlockedError extends Error {
	constructor(lane: string) {
		super(`purge_blocked:${lane}`)
		this.name = 'PurgeBlockedError'
	}
}

export type BlockedPurgeItem = {
	lane: string
	kind: 'org' | 'user'
	id: string
	attempts: number
	lastFailure: string
}

function reportPurgeBlockedToSentry(item: BlockedPurgeItem) {
	try {
		if (!Sentry.isInitialized()) return
		if (!Sentry.getClient()?.getOptions().dsn) return
		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('scheduled.lane', item.lane)
			scope.setTag('retention.purge_kind', item.kind)
			scope.setContext('purge_blocked', {
				id: item.id,
				attempts: item.attempts,
				lastFailure: item.lastFailure,
			})
			Sentry.captureException(new PurgeBlockedError(item.lane))
		})
	} catch (sentryError) {
		console.warn('purge_blocked_sentry_failed', { id: item.id, sentryError })
	}
}

/**
 * Counts a failed attempt on a claim the pass still holds. The attempt that
 * reaches `purgeMaxFailedAttempts` blocks the row: it writes the lane's
 * `purge.blocked` audit and reports to Sentry. Blocked rows are never claimed
 * again, so that happens once per row. Best-effort like the failure audit: a
 * write that fails is logged and the row keeps its lease, which expires.
 */
export async function recordFailedPurgeAttempt(input: {
	lease: PurgeLease
	item: Omit<BlockedPurgeItem, 'attempts'>
	writeBlockedAudit: (item: BlockedPurgeItem) => Promise<unknown>
}): Promise<{ blocked: boolean }> {
	let attempts: number | null
	try {
		attempts = await input.lease.recordFailedAttempt()
	} catch (error) {
		console.warn('purge_failed_attempt_write_failed', {
			lane: input.item.lane,
			id: input.item.id,
			error,
		})
		return { blocked: false }
	}
	if (attempts === null || attempts < purgeMaxFailedAttempts) {
		return { blocked: false }
	}
	const item = { ...input.item, attempts }
	console.warn('purge_blocked', item)
	try {
		await input.writeBlockedAudit(item)
	} catch (auditError) {
		console.warn('purge_blocked_audit_failed', { id: item.id, auditError })
	}
	reportPurgeBlockedToSentry(item)
	return { blocked: true }
}
