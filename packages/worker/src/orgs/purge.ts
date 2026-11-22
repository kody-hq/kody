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

import * as Sentry from '@sentry/cloudflare'
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { softDeletePurgeBatchState } from '#worker/orgs/soft-delete-purge-state.ts'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import {
	TransientD1ItemRetry,
	type TransientRetryBudgetExhausted,
} from '#worker/d1-item-retry.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
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
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
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
			)
			.bind(input.ageCutoff, input.retryBackoffCutoff, input.batchSize)
			.all<{ id: OwnerId; deleted_at: string }>(),
	)
	return results ?? []
}

async function listUserCandidates(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id AS db_user_id, stable_user_id AS id, deleted_at
				 FROM users
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (deleting_at IS NULL OR datetime(deleting_at) < datetime(?))
				 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
				 LIMIT ?`,
			)
			.bind(input.ageCutoff, input.retryBackoffCutoff, input.batchSize)
			.all<{ db_user_id: number; id: OwnerId; deleted_at: string }>(),
	)
	return results ?? []
}

async function listLegacyUserCandidates(input: {
	db: D1Database
	retryBackoffCutoff: string
	batchSize: number
}) {
	// The backoff on `deleting_at` also keeps this lane off deletions that are
	// in flight right now (account deletion stamps the fence when it starts).
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id AS db_user_id, stable_user_id AS id, deleting_at
				 FROM users
				 WHERE deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)
				 ORDER BY datetime(deleting_at) ASC, id ASC
				 LIMIT ?`,
			)
			.bind(input.retryBackoffCutoff, input.batchSize)
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
	const retryBackoffCutoff = cutoffIso(now, softDeletePurgeRetryBackoffMs)
	const batchSize = input.batchSize ?? softDeletePurgeBatchSize
	const orgs = await listOrgCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		batchSize,
	})
	const users = await listUserCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		batchSize,
	})
	const legacyUsers = await listLegacyUserCandidates({
		db: input.env.APP_DB,
		retryBackoffCutoff,
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
}): Promise<boolean> {
	const created = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE orgs
				 SET deleting_at = ?, updated_at = ?
				 WHERE id = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL`,
			)
			.bind(input.nowIso, input.nowIso, input.orgId)
			.run(),
	)
	if ((created.meta.changes ?? 0) === 1) return true
	const restamped = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE orgs
				 SET deleting_at = ?, updated_at = ?
				 WHERE id = ?
				   AND deleted_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
			)
			.bind(input.nowIso, input.nowIso, input.orgId, input.retryBackoffCutoff)
			.run(),
	)
	return (restamped.meta.changes ?? 0) === 1
}

async function claimUserForPurge(input: {
	db: D1Database
	userId: string
	nowIso: string
	retryBackoffCutoff: string
}): Promise<boolean> {
	const created = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				 SET deleting_at = ?, updated_at = ?
				 WHERE stable_user_id = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL`,
			)
			.bind(input.nowIso, input.nowIso, input.userId)
			.run(),
	)
	if ((created.meta.changes ?? 0) === 1) return true
	const restamped = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				 SET deleting_at = ?, updated_at = ?
				 WHERE stable_user_id = ?
				   AND deleted_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
			)
			.bind(input.nowIso, input.nowIso, input.userId, input.retryBackoffCutoff)
			.run(),
	)
	return (restamped.meta.changes ?? 0) === 1
}

/**
 * Claim a legacy deletion by restamping its `deleting_at` fence. Only rows
 * still fenced, still without `deleted_at`, and past the retry backoff are
 * claimed, so concurrent passes and in-flight deletions are left alone. The
 * restamp starts the next backoff window if this attempt fails.
 * Remove when: no account still has a legacy `deleting_at` fence without `deleted_at`.
 */
async function claimLegacyUserForPurge(input: {
	db: D1Database
	userId: string
	nowIso: string
	retryBackoffCutoff: string
}): Promise<boolean> {
	const claimed = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				 SET deleting_at = ?, updated_at = ?
				 WHERE stable_user_id = ?
				   AND deleted_at IS NULL
				   AND deleting_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
			)
			.bind(input.nowIso, input.nowIso, input.userId, input.retryBackoffCutoff)
			.run(),
	)
	return (claimed.meta.changes ?? 0) === 1
}

function reportRetryBudgetExhaustedToSentry(input: {
	candidate: SoftDeletePurgeCandidate
	error: TransientRetryBudgetExhausted
}) {
	try {
		if (!Sentry.isInitialized()) return
		if (!Sentry.getClient()?.getOptions().dsn) return
		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('scheduled.lane', 'soft_delete_purge')
			scope.setContext('soft_delete_purge', {
				kind: input.candidate.kind,
				id: input.candidate.id,
				spentMs: input.error.spentMs,
				budgetMs: input.error.budgetMs,
			})
			Sentry.captureException(input.error)
		})
	} catch (sentryError) {
		console.warn('soft_delete_purge_sentry_failed', {
			id: input.candidate.id,
			error: sentryError,
		})
	}
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
	clock?: () => number
	sleep?: (ms: number) => Promise<void>
}): Promise<SoftDeletePurgeResult> {
	const now = input.now ?? new Date()
	const dryRun =
		input.dryRun === true ||
		(input.dryRun !== false &&
			!(input.enableWrites === true || softDeletePurgeWritesEnabled(input.env)))
	const legacyDryRun = input.dryRun === true
	const budgetMs = input.timeBudgetMs ?? softDeletePurgeRunTimeBudgetMs
	const clock = input.clock ?? Date.now
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const started = clock()
	const retryBackoffCutoff = cutoffIso(now, softDeletePurgeRetryBackoffMs)
	const nowIso = now.toISOString()
	// One retry budget per candidate, shared by its claim and its hard purge
	// (a person purge includes its personal org).
	const itemRetries = new WeakMap<
		SoftDeletePurgeCandidate,
		TransientD1ItemRetry
	>()
	async function runItem<T>(
		candidate: SoftDeletePurgeCandidate,
		work: (retry: TransientD1ItemRetry) => Promise<T>,
	): Promise<T> {
		let retry = itemRetries.get(candidate)
		if (!retry) {
			retry = new TransientD1ItemRetry({ sleep })
			itemRetries.set(candidate, retry)
		}
		try {
			return await work(retry)
		} catch (error) {
			throw retry.failure(error)
		}
	}
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
			readClock: createAsyncLogic<number>({ run: async () => clock() }),
			claimCandidate: createAsyncLogic<boolean, SoftDeletePurgeCandidate>({
				run: ({ input: candidate }) =>
					runItem(candidate, (retry) =>
						candidate.kind === 'org'
							? claimOrgForPurge({
									db: retry.database(input.env.APP_DB),
									orgId: candidate.id,
									nowIso,
									retryBackoffCutoff,
								})
							: candidate.legacy
								? claimLegacyUserForPurge({
										db: retry.database(input.env.APP_DB),
										userId: candidate.id,
										nowIso,
										retryBackoffCutoff,
									})
								: claimUserForPurge({
										db: retry.database(input.env.APP_DB),
										userId: candidate.id,
										nowIso,
										retryBackoffCutoff,
									}),
					),
			}),
			purgeOrg: createAsyncLogic<void, SoftDeletePurgeCandidate>({
				run: ({ input: candidate }) =>
					runItem(candidate, (retry) =>
						hardPurgeOrg({ env: retry.attach(input.env), orgId: candidate.id }),
					),
			}),
			finishLegacyUser: createAsyncLogic<void, SoftDeletePurgeCandidate>({
				run: ({ input: candidate }) =>
					runItem(candidate, async (retry) => {
						await finishLegacyUserDeletion({
							env: retry.attach(input.env),
							dbUserId: candidate.dbUserId!,
							stableUserId: candidate.id,
						})
					}),
			}),
			purgeUser: createAsyncLogic<void, SoftDeletePurgeCandidate>({
				run: ({ input: candidate }) =>
					runItem(candidate, (retry) =>
						hardPurgeSoftDeletedUser({
							env: retry.attach(input.env),
							dbUserId: candidate.dbUserId!,
							stableUserId: candidate.id,
						}),
					),
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
			recordRetryBudgetExhausted: createAsyncLogic<
				string,
				{
					candidate: SoftDeletePurgeCandidate
					error: TransientRetryBudgetExhausted
				}
			>({
				run: async ({ input: { candidate, error } }) => {
					const lane = candidate.legacy
						? 'legacy_deletion_finish'
						: 'soft_delete'
					const lastError = redactPurgeFailureDetail(
						error.cause instanceof Error
							? error.cause.message
							: String(error.cause),
					)
					console.warn(
						JSON.stringify({
							message: 'soft_delete_purge_retry_budget_exhausted',
							kind: candidate.kind,
							lane,
							spentMs: error.spentMs,
							budgetMs: error.budgetMs,
							lastError,
						}),
					)
					await logOrgAuditEvent({
						env: input.env,
						orgId: candidate.id,
						action: 'purge.retry_budget_exhausted',
						result: 'failure',
						detailsJson: JSON.stringify({
							kind: candidate.kind,
							lane,
							spentMs: error.spentMs,
							budgetMs: error.budgetMs,
							lastError,
						}),
						createdAt: nowIso,
					})
					reportRetryBudgetExhaustedToSentry({ candidate, error })
					return `${error.name}: ${error.message}`
				},
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
