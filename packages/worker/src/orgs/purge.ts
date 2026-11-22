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
 * soft-deleted accounts). They keep the same claim, retry backoff, and failure
 * audit as soft-delete candidates. Only an explicit `dryRun: true` previews
 * them.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */

import { createActor, createAsyncLogic, toPromise } from 'xstate'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { softDeletePurgeBatchState } from '#worker/orgs/soft-delete-purge-state.ts'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import {
	finishLegacyUserDeletion,
	hardPurgeOrg,
	hardPurgeSoftDeletedUser,
} from '#worker/orgs/hard-purge.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import {
	fencePurgeFailure,
	purgeClaimLeaseUntil,
	purgeClaimOpenSql,
	purgeDeletingAtSettledSql,
	purgeDeletionInFlightMs,
	recordPurgeBlocked,
	renewPurgeClaimLease,
	type PurgeClaimRow,
	type PurgeFailureFence,
} from '#worker/orgs/purge-claim.ts'
import {
	purgeFailureDetails,
	redactPurgeFailureDetail,
} from '#worker/orgs/purge-failure-details.ts'

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
	nowIso: string
	inFlightCutoff: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id, deleted_at
				 FROM orgs
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (deleting_at IS NULL OR ${purgeDeletingAtSettledSql})
				   AND ${purgeClaimOpenSql}
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
				input.inFlightCutoff,
				input.nowIso,
				input.batchSize,
			)
			.all<{ id: OwnerId; deleted_at: string }>(),
	)
	return results ?? []
}

async function listUserCandidates(input: {
	db: D1Database
	ageCutoff: string
	nowIso: string
	inFlightCutoff: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id AS db_user_id, stable_user_id AS id, deleted_at
				 FROM users
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (deleting_at IS NULL OR ${purgeDeletingAtSettledSql})
				   AND ${purgeClaimOpenSql}
				 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
				 LIMIT ?`,
			)
			.bind(
				input.ageCutoff,
				input.inFlightCutoff,
				input.nowIso,
				input.batchSize,
			)
			.all<{ db_user_id: number; id: OwnerId; deleted_at: string }>(),
	)
	return results ?? []
}

async function listLegacyUserCandidates(input: {
	db: D1Database
	nowIso: string
	inFlightCutoff: string
	batchSize: number
}) {
	// The in-flight window on `deleting_at` keeps this lane off deletions that
	// are running right now (account deletion stamps the fence when it starts).
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id AS db_user_id, stable_user_id AS id, deleting_at
				 FROM users
				 WHERE deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND ${purgeDeletingAtSettledSql}
				   AND ${purgeClaimOpenSql}
				 ORDER BY datetime(deleting_at) ASC, id ASC
				 LIMIT ?`,
			)
			.bind(input.inFlightCutoff, input.nowIso, input.batchSize)
			.all<{ db_user_id: number; id: OwnerId; deleting_at: string }>(),
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
	const nowIso = now.toISOString()
	const inFlightCutoff = cutoffIso(now, purgeDeletionInFlightMs)
	const batchSize = input.batchSize ?? softDeletePurgeBatchSize
	const orgs = await listOrgCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		nowIso,
		inFlightCutoff,
		batchSize,
	})
	const users = await listUserCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		nowIso,
		inFlightCutoff,
		batchSize,
	})
	const legacyUsers = await listLegacyUserCandidates({
		db: input.env.APP_DB,
		nowIso,
		inFlightCutoff,
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

type PurgeClaimInput = {
	db: D1Database
	now: Date
	inFlightCutoff: string
}

/**
 * Take a 15 minute lease on a candidate and stamp `deleting_at`. A row with a
 * live lease, a failure fence, or a block is left alone, so concurrent passes
 * skip it. Returns the lease, or null when another pass holds the row.
 */
async function claimPurgeRow(
	input: PurgeClaimInput & {
		table: 'orgs' | 'users'
		key: string
		/**
		 * `deleted_at` must be set, or (legacy) must be null with a fence.
		 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
		 */
		legacy: boolean
	},
): Promise<string | null> {
	const nowIso = input.now.toISOString()
	const lease = purgeClaimLeaseUntil(input.now)
	const keyColumn = input.table === 'orgs' ? 'id' : 'stable_user_id'
	const update = (fenceCondition: string, fenceBinds: Array<string>) =>
		runD1WithRetry(() =>
			input.db
				.prepare(
					`UPDATE ${input.table}
					 SET deleting_at = ?, purge_fence_until = ?, updated_at = ?
					 WHERE ${keyColumn} = ?
					   AND ${input.legacy ? 'deleted_at IS NULL' : 'deleted_at IS NOT NULL'}
					   AND ${fenceCondition}
					   AND ${purgeClaimOpenSql}`,
				)
				.bind(nowIso, lease, nowIso, input.key, ...fenceBinds, nowIso)
				.run(),
		)
	if (!input.legacy) {
		const created = await update('deleting_at IS NULL', [])
		if ((created.meta.changes ?? 0) === 1) return lease
	}
	const restamped = await update(
		`deleting_at IS NOT NULL AND ${purgeDeletingAtSettledSql}`,
		[input.inFlightCutoff],
	)
	return (restamped.meta.changes ?? 0) === 1 ? lease : null
}

function purgeClaimRow(candidate: SoftDeletePurgeCandidate): PurgeClaimRow {
	return candidate.kind === 'org'
		? { table: 'orgs', column: 'id', key: candidate.id }
		: { table: 'users', column: 'stable_user_id', key: candidate.id }
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
	const inFlightCutoff = cutoffIso(now, purgeDeletionInFlightMs)
	const clock = () => new Date(now.getTime() + Date.now() - started)
	const leases = new Map<string, string>()
	const leaseKey = (candidate: SoftDeletePurgeCandidate) =>
		`${candidate.kind}:${candidate.id}`
	const renewLease = (candidate: SoftDeletePurgeCandidate) => async () => {
		const lease = leases.get(leaseKey(candidate))
		if (lease === undefined) return
		leases.set(
			leaseKey(candidate),
			await renewPurgeClaimLease({
				db: input.env.APP_DB,
				row: purgeClaimRow(candidate),
				lease,
				now: clock(),
			}),
		)
	}
	const nowIso = now.toISOString()
	const workflow = softDeletePurgeBatchState.provide({
		actors: {
			listCandidates: createAsyncLogic<{
				scanned: number
				candidates: Array<SoftDeletePurgeCandidate>
			}>({
				run: () =>
					listSoftDeletePurgeCandidates({
						env: input.env,
						now,
						batchSize: input.batchSize,
					}),
			}),
			readClock: createAsyncLogic<number>({ run: async () => Date.now() }),
			claimCandidate: createAsyncLogic<boolean, SoftDeletePurgeCandidate>({
				run: async ({ input: candidate }) => {
					const lease = await claimPurgeRow({
						db: input.env.APP_DB,
						now,
						inFlightCutoff,
						table: candidate.kind === 'org' ? 'orgs' : 'users',
						key: candidate.id,
						legacy: candidate.legacy === true,
					})
					if (lease === null) return false
					leases.set(leaseKey(candidate), lease)
					return true
				},
			}),
			purgeOrg: createAsyncLogic<void, SoftDeletePurgeCandidate>({
				run: ({ input: candidate }) =>
					hardPurgeOrg({
						env: input.env,
						orgId: candidate.id,
						afterStep: renewLease(candidate),
					}),
			}),
			finishLegacyUser: createAsyncLogic<void, SoftDeletePurgeCandidate>({
				run: async ({ input: candidate }) => {
					await finishLegacyUserDeletion({
						env: input.env,
						dbUserId: candidate.dbUserId!,
						stableUserId: candidate.id,
						afterStep: renewLease(candidate),
					})
				},
			}),
			purgeUser: createAsyncLogic<void, SoftDeletePurgeCandidate>({
				run: ({ input: candidate }) =>
					hardPurgeSoftDeletedUser({
						env: input.env,
						dbUserId: candidate.dbUserId!,
						stableUserId: candidate.id,
						afterStep: renewLease(candidate),
					}),
			}),
			recordFailure: createAsyncLogic<
				string,
				{ candidate: SoftDeletePurgeCandidate; error: unknown }
			>({
				run: async ({ input: { candidate, error } }) => {
					const message = redactPurgeFailureDetail(
						error instanceof Error ? error.message : String(error),
					)
					const cleanupErrors = purgeFailureDetails(error)
					const lane = candidate.legacy
						? 'legacy_deletion_finish'
						: 'soft_delete'
					console.warn(
						JSON.stringify({
							message: 'soft_delete_purge_candidate_failed',
							kind: candidate.kind,
							lane,
							error: message,
							cleanupErrors,
						}),
					)
					await logOrgAuditEvent({
						env: input.env,
						orgId: candidate.id,
						action:
							candidate.kind === 'org'
								? 'org.purge_failed'
								: 'user.purge_failed',
						result: 'failure',
						detailsJson: JSON.stringify({
							error: message,
							...(candidate.legacy ? { lane } : {}),
							...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
						}),
						createdAt: nowIso,
					})
					return message
				},
			}),
			fenceFailure: createAsyncLogic<
				PurgeFailureFence | null,
				SoftDeletePurgeCandidate
			>({
				run: async ({ input: candidate }) => {
					const lease = leases.get(leaseKey(candidate))
					if (lease === undefined) return null
					leases.delete(leaseKey(candidate))
					return fencePurgeFailure({
						db: input.env.APP_DB,
						row: purgeClaimRow(candidate),
						lease,
						now: clock(),
					})
				},
			}),
			recordBlocked: createAsyncLogic<
				void,
				{
					candidate: SoftDeletePurgeCandidate
					attempts: number
					lastFailure: string
				}
			>({
				run: ({ input: { candidate, attempts, lastFailure } }) =>
					recordPurgeBlocked({
						env: input.env,
						kind: candidate.kind,
						id: candidate.id,
						lane: candidate.legacy ? 'legacy_deletion_finish' : 'soft_delete',
						attempts,
						lastFailure,
						createdAt: nowIso,
					}),
			}),
		},
	})
	const output = await toPromise(
		createActor(workflow, {
			input: { dryRun, legacyDryRun, started, budgetMs },
		}).start(),
	)
	if (output.status === 'run_failed') throw output.error
	return {
		dryRun,
		legacyDryRun,
		scanned: output.scanned,
		purged: output.purged,
		failed: output.failed,
		timeBudgetExhausted: output.timeBudgetExhausted,
		outcomes: output.outcomes,
	}
}
