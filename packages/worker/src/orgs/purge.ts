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

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import {
	finishLegacyUserDeletion,
	hardPurgeOrg,
	hardPurgeSoftDeletedUser,
} from '#worker/orgs/hard-purge.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { assertNever, reportLaneError } from '#worker/scheduled/lane-failure.ts'
import {
	purgeFailureDetails,
	redactPurgeFailureDetail,
} from '#worker/orgs/purge-failure-details.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import {
	newPurgeClaim,
	purgeClaimClock,
	purgeClaimFreeSql,
	purgeForeignDeletingAtGraceMs,
	purgeClaimSetSql,
	renewPurgeClaim,
	settlePurgeClaimFailure,
	type PurgeClaim,
	type PurgeClaimRow,
} from '#worker/scheduled/purge-claim.ts'

export { shouldRunRetentionCron as shouldRunSoftDeletePurgeCron }

export const softDeletePurgeBatchSize = 5
export const softDeletePurgeRunTimeBudgetMs = 20_000

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

export type SoftDeletePurgeFailure =
	| {
			kind: 'candidate_failed'
			candidate: SoftDeletePurgeCandidate
			message: string
			cleanupErrors: Array<string>
	  }
	| {
			kind: 'audit_failed'
			candidate: SoftDeletePurgeCandidate
			error: unknown
	  }

/**
 * Reports one failed candidate: a warning plus a `*.purge_failed` audit row.
 * An audit write failure is reported and does not stop the batch.
 */
async function mapSoftDeletePurgeFailure(
	failure: SoftDeletePurgeFailure,
	context: { env: Env; nowIso: string },
): Promise<void> {
	const { candidate } = failure
	const lane = candidate.legacy ? 'legacy_deletion_finish' : 'soft_delete'
	switch (failure.kind) {
		case 'candidate_failed': {
			const { message, cleanupErrors } = failure
			reportLaneError(
				'warn',
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
					env: context.env,
					orgId: candidate.id,
					action:
						candidate.kind === 'org' ? 'org.purge_failed' : 'user.purge_failed',
					result: 'failure',
					detailsJson: JSON.stringify({
						error: message,
						...(candidate.legacy ? { lane } : {}),
						...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
					}),
					createdAt: context.nowIso,
				})
			} catch (error) {
				await mapSoftDeletePurgeFailure(
					{ kind: 'audit_failed', candidate, error },
					context,
				)
			}
			return
		}
		case 'audit_failed':
			reportLaneError(
				'warn',
				JSON.stringify({
					message: 'soft_delete_purge_failure_audit_failed',
					kind: candidate.kind,
					lane,
					error: redactPurgeFailureDetail(
						failure.error instanceof Error
							? failure.error.message
							: String(failure.error),
					),
				}),
			)
			return
		default:
			return assertNever(failure, 'soft delete purge failure')
	}
}

function ageDays(deletedAt: string, now: Date) {
	const deletedMs = Date.parse(deletedAt)
	if (!Number.isFinite(deletedMs)) return 0
	return Math.floor((now.getTime() - deletedMs) / (24 * 60 * 60 * 1000))
}

function cutoffIso(now: Date, millisecondsAgo: number) {
	return new Date(now.getTime() - millisecondsAgo).toISOString()
}

/**
 * Personal orgs of soft-deleted or deletion-fenced people are left out: the
 * person purge removes its personal org after reading its billing identity.
 */
async function listOrgCandidates(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	nowIso: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.listOrgCandidates',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`SELECT id, deleted_at
				 FROM orgs
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (
				     deleting_at IS NULL
				     OR purge_claim_holder IS NOT NULL
				     OR datetime(deleting_at) < datetime(?)
				   )
				   AND ${purgeClaimFreeSql}
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
					)
					.bind(
						input.ageCutoff,
						input.retryBackoffCutoff,
						input.nowIso,
						input.batchSize,
					)
					.all<{ id: OwnerId; deleted_at: string }>(),
		),
	)
	return results ?? []
}

async function listUserCandidates(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	nowIso: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.listUserCandidates',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`SELECT id AS db_user_id, stable_user_id AS id, deleted_at
				 FROM users
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (
				     deleting_at IS NULL
				     OR purge_claim_holder IS NOT NULL
				     OR datetime(deleting_at) < datetime(?)
				   )
				   AND ${purgeClaimFreeSql}
				 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
				 LIMIT ?`,
					)
					.bind(
						input.ageCutoff,
						input.retryBackoffCutoff,
						input.nowIso,
						input.batchSize,
					)
					.all<{ db_user_id: number; id: OwnerId; deleted_at: string }>(),
		),
	)
	return results ?? []
}

async function listLegacyUserCandidates(input: {
	db: D1Database
	retryBackoffCutoff: string
	nowIso: string
	batchSize: number
}) {
	// The grace on `deleting_at` also keeps this lane off deletions that are in
	// flight right now (account deletion stamps the fence when it starts).
	const { results } = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.listLegacyUserCandidates',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`SELECT id AS db_user_id, stable_user_id AS id, deleting_at
				 FROM users
				 WHERE deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND (purge_claim_holder IS NOT NULL OR datetime(deleting_at) < datetime(?))
				   AND ${purgeClaimFreeSql}
				 ORDER BY datetime(deleting_at) ASC, id ASC
				 LIMIT ?`,
					)
					.bind(input.retryBackoffCutoff, input.nowIso, input.batchSize)
					.all<{ db_user_id: number; id: OwnerId; deleting_at: string }>(),
		),
	)
	return results ?? []
}

export async function listSoftDeletePurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<{
	scanned: number
	candidates: Array<SoftDeletePurgeCandidate>
}> {
	const now = input.now ?? new Date()
	const ageCutoff = softDeletePurgeCutoffIso(now)
	const retryBackoffCutoff = cutoffIso(now, purgeForeignDeletingAtGraceMs)
	const nowIso = now.toISOString()
	const batchSize = input.batchSize ?? softDeletePurgeBatchSize
	const orgs = await listOrgCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		nowIso,
		batchSize,
	})
	const users = await listUserCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		nowIso,
		batchSize,
	})
	const legacyUsers = await listLegacyUserCandidates({
		db: input.env.APP_DB,
		retryBackoffCutoff,
		nowIso,
		batchSize,
	})
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
	return { scanned: candidates.length, candidates }
}

async function claimOrgForPurge(input: {
	db: D1Database
	orgId: string
	nowIso: string
	retryBackoffCutoff: string
	claim: PurgeClaim
}): Promise<boolean> {
	const created = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.claimOrgForPurge',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`UPDATE orgs
				 SET deleting_at = ?, updated_at = ?, ${purgeClaimSetSql}
				 WHERE id = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL
				   AND ${purgeClaimFreeSql}`,
					)
					.bind(
						input.nowIso,
						input.nowIso,
						input.claim.holder,
						input.claim.until,
						input.orgId,
						input.nowIso,
					)
					.run(),
		),
	)
	if ((created.meta.changes ?? 0) === 1) return true
	const restamped = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.claimOrgForPurge_2',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`UPDATE orgs
				 SET deleting_at = ?, updated_at = ?, ${purgeClaimSetSql}
				 WHERE id = ?
				   AND deleted_at IS NOT NULL
				   AND (purge_claim_holder IS NOT NULL OR datetime(deleting_at) < datetime(?))
				   AND ${purgeClaimFreeSql}`,
					)
					.bind(
						input.nowIso,
						input.nowIso,
						input.claim.holder,
						input.claim.until,
						input.orgId,
						input.retryBackoffCutoff,
						input.nowIso,
					)
					.run(),
		),
	)
	return (restamped.meta.changes ?? 0) === 1
}

async function claimUserForPurge(input: {
	db: D1Database
	userId: string
	nowIso: string
	retryBackoffCutoff: string
	claim: PurgeClaim
}): Promise<boolean> {
	const created = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.claimUserForPurge',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`UPDATE users
				 SET deleting_at = ?, updated_at = ?, ${purgeClaimSetSql}
				 WHERE stable_user_id = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL
				   AND ${purgeClaimFreeSql}`,
					)
					.bind(
						input.nowIso,
						input.nowIso,
						input.claim.holder,
						input.claim.until,
						input.userId,
						input.nowIso,
					)
					.run(),
		),
	)
	if ((created.meta.changes ?? 0) === 1) return true
	const restamped = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.claimUserForPurge_2',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`UPDATE users
				 SET deleting_at = ?, updated_at = ?, ${purgeClaimSetSql}
				 WHERE stable_user_id = ?
				   AND deleted_at IS NOT NULL
				   AND (purge_claim_holder IS NOT NULL OR datetime(deleting_at) < datetime(?))
				   AND ${purgeClaimFreeSql}`,
					)
					.bind(
						input.nowIso,
						input.nowIso,
						input.claim.holder,
						input.claim.until,
						input.userId,
						input.retryBackoffCutoff,
						input.nowIso,
					)
					.run(),
		),
	)
	return (restamped.meta.changes ?? 0) === 1
}

/**
 * Claim a legacy deletion by restamping its `deleting_at` fence. Only rows
 * still fenced, still without `deleted_at`, claimed before by a lane or
 * stamped longer ago than the foreign-deletion grace, and with no live lease
 * or failure fence are claimed, so concurrent passes and in-flight deletions
 * are left alone.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */
async function claimLegacyUserForPurge(input: {
	db: D1Database
	userId: string
	nowIso: string
	retryBackoffCutoff: string
	claim: PurgeClaim
}): Promise<boolean> {
	const claimed = await runD1WithRetry(() =>
		withDeadline(
			{
				label: 'soft_delete_purge.claimLegacyUserForPurge',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`UPDATE users
				 SET deleting_at = ?, updated_at = ?, ${purgeClaimSetSql}
				 WHERE stable_user_id = ?
				   AND deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND (purge_claim_holder IS NOT NULL OR datetime(deleting_at) < datetime(?))
				   AND ${purgeClaimFreeSql}`,
					)
					.bind(
						input.nowIso,
						input.nowIso,
						input.claim.holder,
						input.claim.until,
						input.userId,
						input.retryBackoffCutoff,
						input.nowIso,
					)
					.run(),
		),
	)
	return (claimed.meta.changes ?? 0) === 1
}

export async function pruneSoftDeleted(input: {
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
}): Promise<SoftDeletePurgeResult> {
	const now = input.now ?? new Date()
	const dryRun =
		input.dryRun === true ||
		(input.dryRun !== false &&
			!(input.enableWrites === true || softDeletePurgeWritesEnabled(input.env)))
	const legacyDryRun = input.dryRun === true
	const budgetMs = input.timeBudgetMs ?? softDeletePurgeRunTimeBudgetMs
	const started = Date.now()
	const preview = await listSoftDeletePurgeCandidates({
		env: input.env,
		now,
		batchSize: input.batchSize,
	})
	const outcomes: Array<SoftDeletePurgeOutcome> = []
	let purged = 0
	let failed = 0
	let timeBudgetExhausted = false

	const legacyFlag = (candidate: SoftDeletePurgeCandidate) =>
		candidate.legacy ? { legacy: true as const } : {}
	const retryBackoffCutoff = cutoffIso(now, purgeForeignDeletingAtGraceMs)
	const nowIso = now.toISOString()
	const laneNow = purgeClaimClock(now, started)

	for (const candidate of preview.candidates) {
		const candidateDryRun = candidate.legacy ? legacyDryRun : dryRun
		if (candidateDryRun) {
			outcomes.push({
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				outcome: 'would_purge',
				...legacyFlag(candidate),
			})
			continue
		}
		if (Date.now() - started > budgetMs) {
			timeBudgetExhausted = true
			break
		}
		const claim = newPurgeClaim(now)
		const claimRow: PurgeClaimRow =
			candidate.kind === 'org'
				? { table: 'orgs', column: 'id', value: candidate.id }
				: { table: 'users', column: 'stable_user_id', value: candidate.id }
		let claimed = false
		try {
			claimed =
				candidate.kind === 'org'
					? await claimOrgForPurge({
							db: input.env.APP_DB,
							orgId: candidate.id,
							nowIso,
							retryBackoffCutoff,
							claim,
						})
					: candidate.legacy
						? await claimLegacyUserForPurge({
								db: input.env.APP_DB,
								userId: candidate.id,
								nowIso,
								retryBackoffCutoff,
								claim,
							})
						: await claimUserForPurge({
								db: input.env.APP_DB,
								userId: candidate.id,
								nowIso,
								retryBackoffCutoff,
								claim,
							})
			if (!claimed) {
				outcomes.push({
					kind: candidate.kind,
					id: candidate.id,
					ageDays: candidate.ageDays,
					outcome: 'skipped_claim',
					...legacyFlag(candidate),
				})
				continue
			}
			const onStepComplete = () =>
				renewPurgeClaim(input.env.APP_DB, {
					row: claimRow,
					holder: claim.holder,
					now: laneNow(),
				})
			if (candidate.kind === 'org') {
				await hardPurgeOrg({
					env: input.env,
					orgId: candidate.id,
					onStepComplete,
				})
			} else if (candidate.legacy) {
				if (candidate.dbUserId == null) {
					throw new Error(`user_purge_missing_db_id:${candidate.id}`)
				}
				await finishLegacyUserDeletion({
					env: input.env,
					dbUserId: candidate.dbUserId,
					stableUserId: candidate.id,
					onStepComplete,
				})
			} else {
				if (candidate.dbUserId == null) {
					throw new Error(`user_purge_missing_db_id:${candidate.id}`)
				}
				await hardPurgeSoftDeletedUser({
					env: input.env,
					dbUserId: candidate.dbUserId,
					stableUserId: candidate.id,
					onStepComplete,
				})
			}
			purged += 1
			outcomes.push({
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				outcome: 'purged',
				...legacyFlag(candidate),
			})
		} catch (error) {
			failed += 1
			const message = redactPurgeFailureDetail(
				error instanceof Error ? error.message : String(error),
			)
			const failure: SoftDeletePurgeFailure = {
				kind: 'candidate_failed',
				candidate,
				message,
				cleanupErrors: purgeFailureDetails(error),
			}
			outcomes.push({
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				outcome: 'failed',
				...legacyFlag(candidate),
				error: message,
			})
			await mapSoftDeletePurgeFailure(failure, { env: input.env, nowIso })
			if (claimed) {
				await settlePurgeClaimFailure(input.env, {
					row: claimRow,
					holder: claim.holder,
					now: laneNow(),
					fence: true,
					item: {
						lane: 'soft_delete_purge',
						kind: candidate.kind,
						id: candidate.id,
						lastFailure: message,
					},
				})
			}
		}
	}

	return {
		dryRun,
		legacyDryRun,
		scanned: preview.scanned,
		purged,
		failed,
		timeBudgetExhausted,
		outcomes,
	}
}
