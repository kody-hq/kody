/**
 * soft-delete-read-filter: opt-out
 *
 * Claim leases, failure fences, and attempt counts for purge candidates
 * (`orgs` and `users` rows, live or soft-deleted). A claim holds a 15 minute
 * lease in `purge_fence_until` that the lane renews after each completed step.
 * A failure keeps the claim behind a 24 hour fence and counts the attempt; the
 * fifth failed attempt marks the row blocked so no lane claims it again.
 */
import * as Sentry from '@sentry/cloudflare'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'

export const purgeClaimLeaseMs = 15 * 60 * 1000
export const purgeFailureFenceMs = 24 * 60 * 60 * 1000
export const purgeMaxAttempts = 5

/**
 * A purge candidate row. `column` names the key the lane claims it by.
 */
export type PurgeClaimRow =
	| { table: 'orgs'; column: 'id'; key: string }
	| { table: 'users'; column: 'stable_user_id'; key: string }
	| { table: 'users'; column: 'id'; key: number }

export class PurgeClaimLostError extends Error {
	constructor(row: PurgeClaimRow) {
		super(`purge_claim_lost:${row.table}`)
		this.name = 'PurgeClaimLostError'
	}
}

export function purgeClaimLeaseUntil(now: Date) {
	return new Date(now.getTime() + purgeClaimLeaseMs).toISOString()
}

/**
 * Account deletion stamps `deleting_at` when it starts. A stamp no purge claim
 * wrote (`purge_fence_until` still null) that is newer than this window may
 * belong to a deletion still running, so no lane claims it yet.
 */
export const purgeDeletionInFlightMs = 6 * 60 * 60 * 1000

/**
 * `deleting_at` was written by a purge claim, or is older than the in-flight
 * window. Binds one parameter: now minus `purgeDeletionInFlightMs`.
 */
export const purgeDeletingAtSettledSql = `(purge_fence_until IS NOT NULL OR datetime(deleting_at) < datetime(?))`

/**
 * Row is not blocked and holds no live lease or failure fence. Binds one
 * parameter: the current time.
 */
export const purgeClaimOpenSql = `purge_blocked_at IS NULL
	AND (purge_fence_until IS NULL OR datetime(purge_fence_until) <= datetime(?))`

/**
 * Extend the lease this pass holds to now + 15 minutes. Throws
 * `PurgeClaimLostError` when another pass took the row after the lease
 * expired, so the item stops before its next step. A row the item already
 * deleted has nothing left to renew.
 */
export async function renewPurgeClaimLease(input: {
	db: D1Database
	row: PurgeClaimRow
	lease: string
	now: Date
}): Promise<string> {
	const next = purgeClaimLeaseUntil(input.now)
	const renewed = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE ${input.row.table}
				 SET purge_fence_until = ?
				 WHERE ${input.row.column} = ? AND purge_fence_until = ?`,
			)
			.bind(next, input.row.key, input.lease)
			.run(),
	)
	if ((renewed.meta.changes ?? 0) === 1) return next
	// A step that deleted the row released the claim with it.
	const present = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT 1 AS present FROM ${input.row.table} WHERE ${input.row.column} = ?`,
			)
			.bind(input.row.key)
			.first<{ present: number }>(),
	)
	if (present) throw new PurgeClaimLostError(input.row)
	return input.lease
}

export type PurgeFailureFence = { attempts: number; blocked: boolean }

/**
 * Keep the claim behind a 24 hour fence and count the failed attempt. The
 * fifth failure also marks the row blocked. Returns null when this pass no
 * longer holds the lease, so a lost claim is neither fenced nor counted.
 */
export async function fencePurgeFailure(input: {
	db: D1Database
	row: PurgeClaimRow
	lease: string
	now: Date
}): Promise<PurgeFailureFence | null> {
	const fenceUntil = new Date(
		input.now.getTime() + purgeFailureFenceMs,
	).toISOString()
	const fenced = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE ${input.row.table}
				 SET purge_attempts = purge_attempts + 1,
				     purge_fence_until = ?,
				     purge_blocked_at = CASE WHEN purge_attempts + 1 >= ? THEN ? ELSE NULL END
				 WHERE ${input.row.column} = ?
				   AND purge_fence_until = ?
				   AND purge_blocked_at IS NULL
				 RETURNING purge_attempts, purge_blocked_at`,
			)
			.bind(
				fenceUntil,
				purgeMaxAttempts,
				input.now.toISOString(),
				input.row.key,
				input.lease,
			)
			.first<{ purge_attempts: number; purge_blocked_at: string | null }>(),
	)
	if (!fenced) return null
	return {
		attempts: fenced.purge_attempts,
		blocked: fenced.purge_blocked_at !== null,
	}
}

/**
 * Record a newly blocked item: one `purge.blocked` audit event and one Sentry
 * report. Callers invoke it only from the failure that set `purge_blocked_at`.
 */
export async function recordPurgeBlocked(input: {
	env: Env
	kind: 'org' | 'user'
	id: string
	lane: string
	attempts: number
	lastFailure: string
	createdAt: string
}) {
	await logOrgAuditEvent({
		env: input.env,
		orgId: input.id,
		action: 'purge.blocked',
		result: 'failure',
		resourceType: input.kind,
		resourceId: input.id,
		detailsJson: JSON.stringify({
			kind: input.kind,
			id: input.id,
			attempts: input.attempts,
			lastFailure: input.lastFailure,
			lane: input.lane,
		}),
		createdAt: input.createdAt,
	})
	reportPurgeBlockedToSentry(input)
}

function reportPurgeBlockedToSentry(input: {
	kind: 'org' | 'user'
	id: string
	lane: string
	attempts: number
	lastFailure: string
}) {
	try {
		if (!Sentry.isInitialized()) return
		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('scheduled.lane', input.lane)
			scope.setContext('purge_blocked', {
				kind: input.kind,
				id: input.id,
				attempts: input.attempts,
				lastFailure: input.lastFailure,
			})
			Sentry.captureException(
				new Error(`purge_blocked:${input.kind}:${input.lane}`),
			)
		})
	} catch (sentryError) {
		console.warn('purge_blocked_sentry_failed', {
			kind: input.kind,
			id: input.id,
			error: sentryError,
		})
	}
}
