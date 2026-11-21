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

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { Cause, DateTime, Effect, Option, Schema } from 'effect'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import {
	finishLegacyUserDeletionEffect,
	hardPurgeOrgEffect,
	hardPurgeSoftDeletedUserEffect,
} from '#worker/orgs/hard-purge.ts'
import {
	purgeFailureDetails,
	redactPurgeFailureDetail,
} from '#worker/orgs/purge-failure-details.ts'
import { AuditLog } from '#worker/effect/audit.ts'
import { startPassBudget } from '#worker/effect/budget.ts'
import { keepClaim, scopedClaim } from '#worker/effect/claim.ts'
import { D1, retryTransientD1, sql } from '#worker/effect/d1.ts'
import { runSlicePromise } from '#worker/effect/slice.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

export { shouldRunRetentionCron as shouldRunSoftDeletePurgeCron }

export const softDeletePurgeBatchSize = 5
export const softDeletePurgeRunTimeBudgetMs = 20_000
export const softDeletePurgeRetryBackoffMs = 6 * 60 * 60 * 1000

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

/** A user candidate row came back without its numeric id. */
export class PurgeCandidateMissingDbIdError extends Schema.TaggedError<PurgeCandidateMissingDbIdError>()(
	'PurgeCandidateMissingDbIdError',
	{ message: Schema.String },
) {}

const OrgCandidateRow = Schema.Struct({
	id: Schema.String,
	deleted_at: Schema.String,
})
const UserCandidateRow = Schema.Struct({
	db_user_id: Schema.Number,
	id: Schema.String,
	deleted_at: Schema.String,
})
const LegacyCandidateRow = Schema.Struct({
	db_user_id: Schema.Number,
	id: Schema.String,
	deleting_at: Schema.String,
})

function ageDays(deletedAt: string, now: Date) {
	const deletedMs = Date.parse(deletedAt)
	if (!Number.isFinite(deletedMs)) return 0
	return Math.floor((now.getTime() - deletedMs) / (24 * 60 * 60 * 1000))
}

function cutoffIso(now: Date, millisecondsAgo: number) {
	return new Date(now.getTime() - millisecondsAgo).toISOString()
}

/** The pass's reference time: the scheduled time, else `Clock`. */
const passTime = (now: Date | undefined) =>
	now ? Effect.succeed(now) : Effect.map(DateTime.now, DateTime.toDateUtc)

type CandidateQuery = {
	readonly ageCutoff: string
	readonly retryBackoffCutoff: string
	readonly batchSize: number
}

/**
 * Personal orgs of soft-deleted or deletion-fenced people are left out: the
 * person purge removes its personal org after reading its billing identity.
 * Unclaimed rows come first, then oldest deletions.
 */
const listOrgCandidates = Effect.fn('SoftDeletePurge.listOrgCandidates')(
	function* (query: CandidateQuery) {
		const db = yield* D1
		return yield* retryTransientD1(
			db.all(
				'soft_delete_purge.org_candidates',
				OrgCandidateRow,
				sql(
					`SELECT id, deleted_at
					 FROM orgs
					 WHERE deleted_at IS NOT NULL
					   AND datetime(deleted_at) < datetime(?)
					   AND (deleting_at IS NULL OR datetime(deleting_at) < datetime(?))
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
					query.ageCutoff,
					query.retryBackoffCutoff,
					query.batchSize,
				),
			),
		)
	},
)

const listUserCandidates = Effect.fn('SoftDeletePurge.listUserCandidates')(
	function* (query: CandidateQuery) {
		const db = yield* D1
		return yield* retryTransientD1(
			db.all(
				'soft_delete_purge.user_candidates',
				UserCandidateRow,
				sql(
					`SELECT id AS db_user_id, stable_user_id AS id, deleted_at
					 FROM users
					 WHERE deleted_at IS NOT NULL
					   AND datetime(deleted_at) < datetime(?)
					   AND (deleting_at IS NULL OR datetime(deleting_at) < datetime(?))
					 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
					 LIMIT ?`,
					query.ageCutoff,
					query.retryBackoffCutoff,
					query.batchSize,
				),
			),
		)
	},
)

/**
 * The backoff on `deleting_at` also keeps this lane off deletions that are in
 * flight right now (account deletion stamps the fence when it starts).
 */
const listLegacyUserCandidates = Effect.fn(
	'SoftDeletePurge.listLegacyUserCandidates',
)(function* (query: Omit<CandidateQuery, 'ageCutoff'>) {
	const db = yield* D1
	return yield* retryTransientD1(
		db.all(
			'soft_delete_purge.legacy_user_candidates',
			LegacyCandidateRow,
			sql(
				`SELECT id AS db_user_id, stable_user_id AS id, deleting_at
				 FROM users
				 WHERE deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)
				 ORDER BY datetime(deleting_at) ASC, id ASC
				 LIMIT ?`,
				query.retryBackoffCutoff,
				query.batchSize,
			),
		),
	)
})

/**
 * Orgs, then soft-deleted users, then legacy deletions, each in claim order.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */
export const listSoftDeletePurgeCandidatesEffect = Effect.fn(
	'SoftDeletePurge.listCandidates',
)(function* (input: { readonly now?: Date; readonly batchSize?: number }) {
	const now = yield* passTime(input.now)
	const query = {
		ageCutoff: softDeletePurgeCutoffIso(now),
		retryBackoffCutoff: cutoffIso(now, softDeletePurgeRetryBackoffMs),
		batchSize: input.batchSize ?? softDeletePurgeBatchSize,
	}
	const orgs = yield* listOrgCandidates(query)
	const users = yield* listUserCandidates(query)
	const legacyUsers = yield* listLegacyUserCandidates(query)
	const candidates: Array<SoftDeletePurgeCandidate> = [
		...orgs.map((row) => ({
			kind: 'org' as const,
			id: row.id as OwnerId,
			deletedAt: row.deleted_at,
			ageDays: ageDays(row.deleted_at, now),
		})),
		...users.map((row) => ({
			kind: 'user' as const,
			id: row.id as OwnerId,
			deletedAt: row.deleted_at,
			ageDays: ageDays(row.deleted_at, now),
			dbUserId: row.db_user_id,
		})),
		...legacyUsers.map((row) => ({
			kind: 'user' as const,
			id: row.id as OwnerId,
			deletedAt: row.deleting_at,
			ageDays: ageDays(row.deleting_at, now),
			dbUserId: row.db_user_id,
			legacy: true as const,
		})),
	]
	yield* Effect.logDebug('soft delete purge candidates listed', {
		orgs: orgs.length,
		users: users.length,
		legacyUsers: legacyUsers.length,
	})
	return { scanned: candidates.length, candidates }
})

type Claim = {
	readonly nowIso: string
	readonly retryBackoffCutoff: string
}

/**
 * Claim a soft-deleted row by stamping `deleting_at`: first an unclaimed
 * row, else one whose earlier claim is older than the 6 hour backoff.
 */
const claimTombstone = Effect.fn('SoftDeletePurge.claimTombstone')(function* (
	table: 'orgs' | 'users',
	key: 'id' | 'stable_user_id',
	id: OwnerId,
	claim: Claim,
) {
	const db = yield* D1
	const created = yield* retryTransientD1(
		db.run(
			`soft_delete_purge.claim_${table}`,
			sql(
				`UPDATE ${table}
				 SET deleting_at = ?, updated_at = ?
				 WHERE ${key} = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL`,
				claim.nowIso,
				claim.nowIso,
				id,
			),
		),
	)
	if (created.changes === 1) return true
	const restamped = yield* retryTransientD1(
		db.run(
			`soft_delete_purge.restamp_${table}`,
			sql(
				`UPDATE ${table}
				 SET deleting_at = ?, updated_at = ?
				 WHERE ${key} = ?
				   AND deleted_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
				claim.nowIso,
				claim.nowIso,
				id,
				claim.retryBackoffCutoff,
			),
		),
	)
	return restamped.changes === 1
})

/**
 * Claim a legacy deletion by restamping its `deleting_at` fence. Only rows
 * still fenced, still without `deleted_at`, and past the retry backoff are
 * claimed, so concurrent passes and in-flight deletions are left alone.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */
const claimLegacyUser = Effect.fn('SoftDeletePurge.claimLegacyUser')(function* (
	userId: OwnerId,
	claim: Claim,
) {
	const db = yield* D1
	const claimed = yield* retryTransientD1(
		db.run(
			'soft_delete_purge.claim_legacy_user',
			sql(
				`UPDATE users
				 SET deleting_at = ?, updated_at = ?
				 WHERE stable_user_id = ?
				   AND deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
				claim.nowIso,
				claim.nowIso,
				userId,
				claim.retryBackoffCutoff,
			),
		),
	)
	return claimed.changes === 1
})

const claimCandidate = (candidate: SoftDeletePurgeCandidate, claim: Claim) =>
	(candidate.kind === 'org'
		? claimTombstone('orgs', 'id', candidate.id, claim)
		: candidate.legacy
			? claimLegacyUser(candidate.id, claim)
			: claimTombstone('users', 'stable_user_id', candidate.id, claim)
	).pipe(
		Effect.map((claimed) => (claimed ? Option.some(candidate) : Option.none())),
	)

const requireDbUserId = (candidate: SoftDeletePurgeCandidate) =>
	candidate.dbUserId == null
		? Effect.fail(
				new PurgeCandidateMissingDbIdError({
					message: `user_purge_missing_db_id:${candidate.id}`,
				}),
			)
		: Effect.succeed(candidate.dbUserId)

const purgeCandidate = (candidate: SoftDeletePurgeCandidate) =>
	candidate.kind === 'org'
		? hardPurgeOrgEffect(candidate.id)
		: Effect.flatMap(requireDbUserId(candidate), (dbUserId) =>
				candidate.legacy
					? Effect.asVoid(
							finishLegacyUserDeletionEffect({
								dbUserId,
								stableUserId: candidate.id,
							}),
						)
					: hardPurgeSoftDeletedUserEffect({
							dbUserId,
							stableUserId: candidate.id,
						}),
			)

/**
 * One candidate: claim (kept on every exit so the backoff owns retries),
 * purge, and on any failure record a redacted `*.purge_failed` audit event.
 */
const processCandidate = Effect.fn('SoftDeletePurge.processCandidate')(
	function* (candidate: SoftDeletePurgeCandidate, claim: Claim) {
		const audit = yield* AuditLog
		yield* Effect.annotateCurrentSpan({
			'kody.purge_kind': candidate.kind,
			'kody.purge_legacy': candidate.legacy === true,
		})
		const base = {
			kind: candidate.kind,
			id: candidate.id,
			ageDays: candidate.ageDays,
			...(candidate.legacy ? { legacy: true as const } : {}),
		}
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const claimed = yield* scopedClaim(
					claimCandidate(candidate, claim),
					keepClaim('soft_delete_purge'),
				)
				if (Option.isNone(claimed)) {
					return {
						...base,
						outcome: 'skipped_claim',
					} satisfies SoftDeletePurgeOutcome
				}
				yield* purgeCandidate(candidate)
				return { ...base, outcome: 'purged' } satisfies SoftDeletePurgeOutcome
			}),
		).pipe(
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					const error = Cause.squash(cause)
					const message = redactPurgeFailureDetail(
						error instanceof Error ? error.message : String(error),
					)
					const cleanupErrors = purgeFailureDetails(error)
					const lane = candidate.legacy
						? 'legacy_deletion_finish'
						: 'soft_delete'
					yield* Effect.logWarning(
						JSON.stringify({
							message: 'soft_delete_purge_candidate_failed',
							kind: candidate.kind,
							lane,
							error: message,
							cleanupErrors,
						}),
					)
					yield* audit.recordOrg({
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
						createdAt: claim.nowIso,
					})
					return {
						...base,
						outcome: 'failed',
						error: message,
					} satisfies SoftDeletePurgeOutcome
				}),
			),
		)
	},
)

export const pruneSoftDeletedEffect = Effect.fn('SoftDeletePurge.prune')(
	function* (input: {
		readonly now?: Date
		readonly timeBudgetMs?: number
		readonly batchSize?: number
		/**
		 * When true, list only. When false, hard-delete soft-deleted rows if
		 * writes are enabled. Legacy deletions run unless this is true.
		 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
		 */
		readonly dryRun?: boolean
		readonly enableWrites?: boolean
	}) {
		const env = yield* WorkerEnv
		const now = yield* passTime(input.now)
		const dryRun =
			input.dryRun === true ||
			(input.dryRun !== false &&
				!(input.enableWrites === true || softDeletePurgeWritesEnabled(env)))
		const legacyDryRun = input.dryRun === true
		const budget = yield* startPassBudget(
			input.timeBudgetMs ?? softDeletePurgeRunTimeBudgetMs,
		)
		const preview = yield* listSoftDeletePurgeCandidatesEffect({
			now,
			batchSize: input.batchSize,
		})
		const claim: Claim = {
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
			if (yield* budget.exceeded) {
				timeBudgetExhausted = true
				break
			}
			outcomes.push(yield* processCandidate(candidate, claim))
		}
		const result: SoftDeletePurgeResult = {
			dryRun,
			legacyDryRun,
			scanned: preview.scanned,
			purged: outcomes.filter((outcome) => outcome.outcome === 'purged').length,
			failed: outcomes.filter((outcome) => outcome.outcome === 'failed').length,
			timeBudgetExhausted,
			outcomes,
		}
		yield* Effect.logDebug('soft delete purge pass finished', {
			scanned: result.scanned,
			purged: result.purged,
			failed: result.failed,
			timeBudgetExhausted,
		})
		return result
	},
)

export function listSoftDeletePurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<{ scanned: number; candidates: Array<SoftDeletePurgeCandidate> }> {
	const { env, ...rest } = input
	return runSlicePromise(env, listSoftDeletePurgeCandidatesEffect(rest))
}

export function pruneSoftDeleted(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
	dryRun?: boolean
	enableWrites?: boolean
}): Promise<SoftDeletePurgeResult> {
	const { env, ...rest } = input
	return runSlicePromise(env, pruneSoftDeletedEffect(rest))
}
