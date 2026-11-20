/**
 * soft-delete-read-filter: opt-out
 *
 * Purge claims and hard-deletes soft-deleted rows past the retention window.
 *
 * It also finishes legacy account deletions: person rows the pre-soft-delete
 * deletion flow fenced with `deleting_at` but never finished (`deleted_at`
 * null). Those owners asked for a hard deletion and were never offered a
 * restore window, so they skip the 30-day window and the
 * `SOFT_DELETE_PURGE_ENABLED` gate (which guards purging restorable
 * soft-deleted accounts). They keep the same claim lease, failure fence, and
 * failure audit as soft-delete candidates. Only an explicit `dryRun: true` previews
 * them.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */

import { z } from 'zod'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import {
	finishLegacyUserDeletion,
	hardPurgeOrg,
	hardPurgeSoftDeletedUser,
} from '#worker/orgs/hard-purge.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import {
	purgeFailureDetails,
	redactPurgeFailureDetail,
} from '#worker/orgs/purge-failure-details.ts'
import { type Clock, systemClock } from '#worker/scheduled/retention/clock.ts'
import { startPassBudget } from '#worker/scheduled/retention/budget.ts'
import {
	type ClaimOutcome,
	runClaimed,
} from '#worker/scheduled/retention/claim.ts'
import {
	d1All,
	d1Run,
	type RetentionContext,
} from '#worker/scheduled/retention/d1.ts'
import { assertNever } from '#worker/scheduled/retention/failures.ts'
import {
	dbIdColumn,
	ownerIdColumn,
	timestampColumn,
} from '#worker/scheduled/retention/rows.ts'
import {
	type BlockedPurgeItem,
	holdPurgeLease,
	type PurgeLease,
	purgeClaimableSql,
	purgeLeaseExpiresAt,
	recordFailedPurgeAttempt,
} from '#worker/scheduled/retention/purge-lease.ts'
import { traced } from '#worker/scheduled/retention/telemetry.ts'

export { shouldRunRetentionCron as shouldRunSoftDeletePurgeCron }

export const softDeletePurgeBatchSize = 5
export const softDeletePurgeRunTimeBudgetMs = 20_000
/**
 * How long a `deleting_at` no purge claim wrote (an account deletion in
 * flight, a claim from before leases) keeps candidates off this lane. Purge
 * claims use the lease and failure fence in `purge-lease.ts` instead.
 */
export const softDeletePurgeRetryBackoffMs = 6 * 60 * 60 * 1000

const dayMs = 24 * 60 * 60 * 1000

export function softDeletePurgeWritesEnabled(env: Env): boolean {
	return (
		(
			env as Env & { SOFT_DELETE_PURGE_ENABLED?: string }
		).SOFT_DELETE_PURGE_ENABLED?.trim() === 'true'
	)
}

export type SoftDeletePurgeCandidate = {
	kind: 'org' | 'user'
	id: OwnerId
	/**
	 * `deleted_at` for soft-deleted rows. For legacy deletions (`legacy: true`)
	 * this is the `deleting_at` fence, the closest record of when the deletion
	 * was requested or last retried.
	 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
	 */
	deletedAt: string
	ageDays: number
	dbUserId?: number
	/** Pre-soft-delete account deletion left with `deleting_at` only. */
	legacy?: true
}

export type SoftDeletePurgeOutcomeKind =
	| 'purged'
	| 'failed'
	| 'skipped_claim'
	| 'would_purge'

export type SoftDeletePurgeOutcome = {
	kind: 'org' | 'user'
	id: OwnerId
	ageDays: number
	outcome: SoftDeletePurgeOutcomeKind
	legacy?: true
	error?: string
	/** This failure was the last allowed attempt; no lane claims it again. */
	blocked?: true
}

export type SoftDeletePurgeResult = {
	/** Soft-deleted (restorable) candidates were only listed. */
	dryRun: boolean
	/**
	 * Legacy deletion candidates were only listed.
	 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
	 */
	legacyDryRun: boolean
	scanned: number
	purged: number
	failed: number
	timeBudgetExhausted: boolean
	outcomes: Array<SoftDeletePurgeOutcome>
}

/** Which purge path owns a candidate; decides its claim and hard purge. */
type PurgeLane = 'org' | 'user' | 'legacy_user'

function laneOf(candidate: SoftDeletePurgeCandidate): PurgeLane {
	if (candidate.kind === 'org') return 'org'
	return candidate.legacy ? 'legacy_user' : 'user'
}

function ageDays(deletedAt: string, now: Date) {
	const deletedMs = Date.parse(deletedAt)
	if (!Number.isFinite(deletedMs)) return 0
	return Math.floor((now.getTime() - deletedMs) / dayMs)
}

function cutoffIso(now: Date, millisecondsAgo: number) {
	return new Date(now.getTime() - millisecondsAgo).toISOString()
}

const orgCandidateRow = z.object({
	id: ownerIdColumn,
	deleted_at: timestampColumn,
})
const userCandidateRow = z.object({
	db_user_id: dbIdColumn,
	id: ownerIdColumn,
	deleted_at: timestampColumn,
})
const legacyUserCandidateRow = z.object({
	db_user_id: dbIdColumn,
	id: ownerIdColumn,
	deleting_at: timestampColumn,
})

type CandidateWindow = {
	ageCutoff: string
	leaseNow: string
	retryBackoffCutoff: string
	batchSize: number
}

/**
 * Personal orgs of soft-deleted or deletion-fenced people are left out: the
 * person purge removes its personal org after reading its billing identity.
 * Never-claimed rows sort first, then oldest deletion, then id.
 */
function listOrgCandidates(ctx: RetentionContext, window: CandidateWindow) {
	return d1All(ctx, {
		operation: 'soft_delete_purge.list_org_candidates',
		sql: `SELECT id, deleted_at
			 FROM orgs
			 WHERE deleted_at IS NOT NULL
			   AND datetime(deleted_at) < datetime(?)
			   AND ${purgeClaimableSql}
			   AND NOT EXISTS (
			     SELECT 1 FROM users u
			     WHERE (u.deleted_at IS NOT NULL OR u.deleting_at IS NOT NULL)
			       AND (
			         (NULLIF(TRIM(u.personal_org_id), '') = orgs.id)
			         OR (NULLIF(TRIM(u.personal_org_id), '') IS NULL AND u.stable_user_id = orgs.id)
			       )
			   )
			 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
			 LIMIT ?`,
		bindings: [
			window.ageCutoff,
			window.leaseNow,
			window.retryBackoffCutoff,
			window.batchSize,
		],
		row: orgCandidateRow,
	})
}

function listUserCandidates(ctx: RetentionContext, window: CandidateWindow) {
	return d1All(ctx, {
		operation: 'soft_delete_purge.list_user_candidates',
		sql: `SELECT id AS db_user_id, stable_user_id AS id, deleted_at
			 FROM users
			 WHERE deleted_at IS NOT NULL
			   AND datetime(deleted_at) < datetime(?)
			   AND ${purgeClaimableSql}
			 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
			 LIMIT ?`,
		bindings: [
			window.ageCutoff,
			window.leaseNow,
			window.retryBackoffCutoff,
			window.batchSize,
		],
		row: userCandidateRow,
	})
}

/**
 * The unleased-fence backoff on `deleting_at` also keeps this lane off
 * deletions that are in flight right now (account deletion stamps the fence
 * when it starts).
 */
function listLegacyUserCandidates(
	ctx: RetentionContext,
	window: CandidateWindow,
) {
	return d1All(ctx, {
		operation: 'soft_delete_purge.list_legacy_user_candidates',
		sql: `SELECT id AS db_user_id, stable_user_id AS id, deleting_at
			 FROM users
			 WHERE deleted_at IS NULL
			   AND deleting_at IS NOT NULL
			   AND ${purgeClaimableSql}
			 ORDER BY datetime(deleting_at) ASC, id ASC
			 LIMIT ?`,
		bindings: [window.leaseNow, window.retryBackoffCutoff, window.batchSize],
		row: legacyUserCandidateRow,
	})
}

export function listSoftDeletePurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
	clock?: Clock
	signal?: AbortSignal
}): Promise<{
	scanned: number
	candidates: Array<SoftDeletePurgeCandidate>
}> {
	const clock = input.clock ?? systemClock
	const batchSize = input.batchSize ?? softDeletePurgeBatchSize
	return traced(
		'retention.soft_delete_purge.list_candidates',
		{ 'retention.batch_size': batchSize },
		async (span) => {
			const ctx = { db: input.env.APP_DB, clock, signal: input.signal }
			const now = input.now ?? clock.now()
			const window: CandidateWindow = {
				ageCutoff: softDeletePurgeCutoffIso(now),
				leaseNow: clock.now().toISOString(),
				retryBackoffCutoff: cutoffIso(now, softDeletePurgeRetryBackoffMs),
				batchSize,
			}
			const orgs = await listOrgCandidates(ctx, window)
			const users = await listUserCandidates(ctx, window)
			const legacyUsers = await listLegacyUserCandidates(ctx, window)
			const candidates: Array<SoftDeletePurgeCandidate> = [
				...orgs.map((row) => ({
					kind: 'org' as const,
					id: row.id,
					deletedAt: row.deleted_at,
					ageDays: ageDays(row.deleted_at, now),
				})),
				...users.map((row) => ({
					kind: 'user' as const,
					id: row.id,
					deletedAt: row.deleted_at,
					ageDays: ageDays(row.deleted_at, now),
					dbUserId: row.db_user_id,
				})),
				...legacyUsers.map((row) => ({
					kind: 'user' as const,
					id: row.id,
					deletedAt: row.deleting_at,
					ageDays: ageDays(row.deleting_at, now),
					dbUserId: row.db_user_id,
					legacy: true as const,
				})),
			]
			span.setAttribute('retention.scanned', candidates.length)
			return { scanned: candidates.length, candidates }
		},
		clock,
	)
}

type ClaimStamp = { nowIso: string; retryBackoffCutoff: string }

/**
 * Claims a candidate by stamping `deleting_at` and a 15 minute lease.
 * Soft-deleted rows are claimed when never fenced, or restamped once the
 * fence is claimable (`purgeClaimableSql`). Legacy deletions are always
 * fenced already, so only the restamp applies.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */
async function claimCandidate(
	ctx: RetentionContext,
	lane: PurgeLane,
	id: OwnerId,
	stamp: ClaimStamp,
): Promise<PurgeLease | null> {
	const table = lane === 'org' ? 'orgs' : 'users'
	const idColumn = lane === 'org' ? 'id' : 'stable_user_id'
	const leaseNow = ctx.clock.now().toISOString()
	const leaseExpiresAt = purgeLeaseExpiresAt(ctx.clock)
	const deletedFilter =
		lane === 'legacy_user'
			? 'deleted_at IS NULL AND deleting_at IS NOT NULL'
			: 'deleted_at IS NOT NULL'
	const claim = (fenceFilter: string) =>
		d1Run(ctx, {
			operation: `soft_delete_purge.claim_${lane}`,
			sql: `UPDATE ${table}
				 SET deleting_at = ?, purge_lease_expires_at = ?, updated_at = ?
				 WHERE ${idColumn} = ?
				   AND ${deletedFilter}
				   AND ${fenceFilter}
				   AND ${purgeClaimableSql}`,
			bindings: [
				stamp.nowIso,
				leaseExpiresAt,
				stamp.nowIso,
				id,
				leaseNow,
				stamp.retryBackoffCutoff,
			],
		})
	const claimed =
		(lane !== 'legacy_user' && (await claim('deleting_at IS NULL')) === 1) ||
		(await claim('deleting_at IS NOT NULL')) === 1
	return claimed
		? holdPurgeLease(ctx, { table, idColumn, id }, leaseExpiresAt)
		: null
}

class MissingDbUserIdError extends Error {
	constructor(id: OwnerId) {
		super(`user_purge_missing_db_id:${id}`)
		this.name = 'MissingDbUserIdError'
	}
}

async function hardPurgeCandidate(
	env: Env,
	lane: PurgeLane,
	candidate: SoftDeletePurgeCandidate,
	lease: PurgeLease,
) {
	const onStepComplete = () => lease.renew()
	if (lane === 'org') {
		await hardPurgeOrg({ env, orgId: candidate.id, onStepComplete })
		return
	}
	if (candidate.dbUserId == null) throw new MissingDbUserIdError(candidate.id)
	const user = {
		env,
		dbUserId: candidate.dbUserId,
		stableUserId: candidate.id,
		onStepComplete,
	}
	switch (lane) {
		case 'user':
			await hardPurgeSoftDeletedUser(user)
			return
		case 'legacy_user':
			await finishLegacyUserDeletion(user)
			return
		default:
			assertNever(lane)
	}
}

/**
 * Records a failed purge. The failure audit is best-effort: an audit write
 * that fails is logged and the pass moves on to the next candidate.
 */
async function recordCandidateFailure(input: {
	env: Env
	candidate: SoftDeletePurgeCandidate
	error: unknown
	nowIso: string
}): Promise<string> {
	const { candidate } = input
	const message = redactPurgeFailureDetail(
		input.error instanceof Error ? input.error.message : String(input.error),
	)
	const cleanupErrors = purgeFailureDetails(input.error)
	const lane = candidate.legacy ? 'legacy_deletion_finish' : 'soft_delete'
	console.warn(
		JSON.stringify({
			message: 'soft_delete_purge_candidate_failed',
			kind: candidate.kind,
			lane,
			error: message,
			cleanupErrors,
		}),
	)
	try {
		await logOrgAuditEvent({
			env: input.env,
			orgId: candidate.id,
			action:
				candidate.kind === 'org' ? 'org.purge_failed' : 'user.purge_failed',
			result: 'failure',
			detailsJson: JSON.stringify({
				error: message,
				...(candidate.legacy ? { lane } : {}),
				...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
			}),
			createdAt: input.nowIso,
		})
	} catch (auditError) {
		console.warn(
			JSON.stringify({
				message: 'soft_delete_purge_failure_audit_failed',
				kind: candidate.kind,
				lane,
				error: redactPurgeFailureDetail(
					auditError instanceof Error ? auditError.message : String(auditError),
				),
			}),
		)
	}
	return message
}

function writePurgeBlockedAudit(
	env: Env,
	item: BlockedPurgeItem,
	nowIso: string,
) {
	return logOrgAuditEvent({
		env,
		orgId: item.id,
		action: 'purge.blocked',
		result: 'failure',
		detailsJson: JSON.stringify({
			kind: item.kind,
			id: item.id,
			attempts: item.attempts,
			lastFailure: item.lastFailure,
		}),
		createdAt: nowIso,
	})
}

function purgeOneCandidate(input: {
	env: Env
	ctx: RetentionContext
	candidate: SoftDeletePurgeCandidate
	stamp: ClaimStamp
}): Promise<SoftDeletePurgeOutcome> {
	const { candidate } = input
	const lane = laneOf(candidate)
	return traced(
		'retention.soft_delete_purge.candidate',
		{ 'retention.lane': lane, 'retention.age_days': candidate.ageDays },
		async (span) => {
			const base = {
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				...(candidate.legacy ? { legacy: true as const } : {}),
			}
			const held: { lease: PurgeLease | null } = { lease: null }
			const failed = async (error: unknown) => {
				span.setAttribute('retention.outcome', 'failed')
				const message = await recordCandidateFailure({
					env: input.env,
					candidate,
					error,
					nowIso: input.stamp.nowIso,
				})
				const { blocked } = held.lease
					? await recordFailedPurgeAttempt({
							lease: held.lease,
							item: {
								lane: 'soft_delete_purge',
								kind: candidate.kind,
								id: candidate.id,
								lastFailure: message,
							},
							writeBlockedAudit: (item) =>
								writePurgeBlockedAudit(input.env, item, input.stamp.nowIso),
						})
					: { blocked: false }
				span.setAttribute('retention.blocked', blocked)
				return {
					...base,
					outcome: 'failed' as const,
					error: message,
					...(blocked ? { blocked: true as const } : {}),
				}
			}
			let outcome: ClaimOutcome<void>
			try {
				outcome = await runClaimed({
					acquire: async () => {
						held.lease = await claimCandidate(
							input.ctx,
							lane,
							candidate.id,
							input.stamp,
						)
						return held.lease
					},
					body: (lease) =>
						hardPurgeCandidate(input.env, lane, candidate, lease),
					// The claim stays as the 24 hour failure fence, written by
					// `recordFailedPurgeAttempt`.
					onFailure: () => 'keep',
					release: async () => {},
				})
			} catch (claimError) {
				// The claim write itself failed, so no fence was stamped.
				return failed(claimError)
			}
			switch (outcome.status) {
				case 'not_claimed':
					span.setAttribute('retention.outcome', 'skipped_claim')
					return { ...base, outcome: 'skipped_claim' }
				case 'completed':
					span.setAttribute('retention.outcome', 'purged')
					return { ...base, outcome: 'purged' }
				case 'failed':
					return failed(outcome.error)
				default:
					return assertNever(outcome)
			}
		},
		input.ctx.clock,
	)
}

export function pruneSoftDeleted(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
	/**
	 * When true, list only. When false, hard-delete soft-deleted rows if
	 * writes are enabled. Legacy deletions run unless this is true.
	 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
	 */
	dryRun?: boolean
	enableWrites?: boolean
	clock?: Clock
	signal?: AbortSignal
}): Promise<SoftDeletePurgeResult> {
	const clock = input.clock ?? systemClock
	const dryRun =
		input.dryRun === true ||
		(input.dryRun !== false &&
			!(input.enableWrites === true || softDeletePurgeWritesEnabled(input.env)))
	const legacyDryRun = input.dryRun === true
	return traced(
		'retention.soft_delete_purge',
		{ 'retention.dry_run': dryRun, 'retention.legacy_dry_run': legacyDryRun },
		async (span) => {
			const now = input.now ?? clock.now()
			const budget = startPassBudget(
				clock,
				input.timeBudgetMs ?? softDeletePurgeRunTimeBudgetMs,
			)
			const ctx = { db: input.env.APP_DB, clock, signal: input.signal }
			const preview = await listSoftDeletePurgeCandidates({
				env: input.env,
				now,
				batchSize: input.batchSize,
				clock,
				signal: input.signal,
			})
			const stamp: ClaimStamp = {
				nowIso: now.toISOString(),
				retryBackoffCutoff: cutoffIso(now, softDeletePurgeRetryBackoffMs),
			}
			const outcomes: Array<SoftDeletePurgeOutcome> = []
			let timeBudgetExhausted = false
			for (const candidate of preview.candidates) {
				if (candidate.legacy ? legacyDryRun : dryRun) {
					outcomes.push({
						kind: candidate.kind,
						id: candidate.id,
						ageDays: candidate.ageDays,
						outcome: 'would_purge',
						...(candidate.legacy ? { legacy: true as const } : {}),
					})
					continue
				}
				if (budget.exceeded()) {
					timeBudgetExhausted = true
					break
				}
				outcomes.push(
					await purgeOneCandidate({ env: input.env, ctx, candidate, stamp }),
				)
			}
			const purged = outcomes.filter((o) => o.outcome === 'purged').length
			const failed = outcomes.filter((o) => o.outcome === 'failed').length
			span.setAttribute('retention.scanned', preview.scanned)
			span.setAttribute('retention.purged', purged)
			span.setAttribute('retention.failed', failed)
			span.setAttribute('retention.budget_exhausted', timeBudgetExhausted)
			return {
				dryRun,
				legacyDryRun,
				scanned: preview.scanned,
				purged,
				failed,
				timeBudgetExhausted,
				outcomes,
			}
		},
		clock,
	)
}
