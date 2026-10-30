import { type RequestCredential } from '@kody-internal/shared/request-context.ts'
/**
 * Owner cron enablement for scheduled package jobs.
 *
 * Creating a job (package sync insert) turns it on for the creator/owner so
 * the next tick runs. Other package triggers still never auto-enable on
 * publish. The admin backfill repairs enabled jobs that predate that rule.
 */

import {
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { packageIdFromJobId } from '@kody-internal/shared/jobs/package-job-id.ts'
import { jobsData, type JobsDataEnv } from '#worker/jobs/jobs-data.ts'
import {
	insertEnablement,
	loadEarliestLiveOwnerId,
	updateCronEnablerNarrowing,
} from './repo.ts'
import { type EnablementRecord } from './types.ts'

/**
 * True when this enabler already has any cron enablement row for the job,
 * including `off`. Skipping off avoids re-enabling someone who disabled.
 */
async function ownerHasCronEnablementRow(input: {
	db: D1Database
	orgId: string
	jobId: string
	jobName: string
	enablerUserId: string
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT id AS id FROM enablements
			 WHERE org_id = ? AND trigger_kind = 'cron' AND instance_id = ?
			   AND trigger_name = ? AND enabler_user_id = ?
			 LIMIT 1`,
		)
		.bind(input.orgId, input.jobId, input.jobName, input.enablerUserId)
		.first<{ id: string }>()
	return row != null
}

/** What the person turning a trigger on could do with their credential. */
export type EnablerCredential = Pick<
	RequestCredential,
	'scopes' | 'profileName'
>

export type OwnerCronEnablementOutcome =
	| 'inserted'
	| 'already_present'
	| 'skipped_no_owner'
	| 'skipped_bad_job_id'

export type OwnerCronEnablementBackfillRowOutcome =
	| OwnerCronEnablementOutcome
	| 'skipped_not_enabled'
	| 'failed'

/**
 * Person who should own the auto enablement for jobs in this org: the live
 * personal-org user when the org is personal, else the earliest live Owner.
 */
export async function resolveOwnerPersonIdForCronEnablement(
	db: D1Database,
	orgId: OwnerId | string,
): Promise<PersonId | null> {
	const user = await db
		.prepare(
			`SELECT stable_user_id AS stable_user_id
			 FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)
			   AND deleted_at IS NULL
			   AND deleting_at IS NULL
			   AND suspended_at IS NULL`,
		)
		.bind(orgId, orgId)
		.first<{ stable_user_id: string }>()
	if (user?.stable_user_id) {
		return personIdFromStored(user.stable_user_id)
	}
	const earliestOwnerId = await loadEarliestLiveOwnerId(db, String(orgId))
	return earliestOwnerId ? personIdFromStored(earliestOwnerId) : null
}

/**
 * Ensure the org owner has a non-off cron enablement for this job. Idempotent:
 * skips when they already have on, paused, or off (off means they disabled).
 */
export async function ensureOwnerCronEnablementForJob(input: {
	db: D1Database
	orgId: OwnerId | string
	jobId: string
	jobName: string
	packageId?: string | null
	enablerUserId?: PersonId | string | null
	now?: string
	/**
	 * The credential the enabler used, when they are the person acting now.
	 * Scheduled runs never exceed it.
	 */
	enablerCredential?: EnablerCredential | null
	/**
	 * The enabler is turning the job on now: an existing row of theirs takes
	 * `enablerCredential` as its narrowing instead of keeping the old one.
	 */
	refreshEnablerCredential?: boolean
	/** Runs after a new enablement row is written (for the audit log). */
	onInserted?: (enablement: EnablementRecord) => Promise<unknown>
}): Promise<OwnerCronEnablementOutcome> {
	const packageId = input.packageId ?? packageIdFromJobId(input.jobId) ?? null
	if (!packageId) return 'skipped_bad_job_id'

	const enablerUserId =
		input.enablerUserId ??
		(await resolveOwnerPersonIdForCronEnablement(input.db, input.orgId))
	if (!enablerUserId) return 'skipped_no_owner'

	if (
		await ownerHasCronEnablementRow({
			db: input.db,
			orgId: String(input.orgId),
			jobId: input.jobId,
			jobName: input.jobName,
			enablerUserId: String(enablerUserId),
		})
	) {
		if (
			input.refreshEnablerCredential &&
			input.enablerUserId &&
			input.enablerCredential
		) {
			await updateCronEnablerNarrowing({
				db: input.db,
				orgId: String(input.orgId),
				jobId: input.jobId,
				jobName: input.jobName,
				enablerUserId: String(enablerUserId),
				enablerScopes: input.enablerCredential.scopes,
				enablerProfileName: input.enablerCredential.profileName,
				now: input.now,
			})
		}
		return 'already_present'
	}

	const inserted = await insertEnablement({
		db: input.db,
		enablement: {
			orgId: String(input.orgId),
			packageId,
			triggerKind: 'cron',
			triggerName: input.jobName,
			instanceId: input.jobId,
			enablerUserId: String(enablerUserId),
			...(input.enablerUserId && input.enablerCredential
				? {
						enablerScopes: input.enablerCredential.scopes,
						enablerProfileName: input.enablerCredential.profileName,
					}
				: {}),
			origin: 'enabled',
		},
		now: input.now,
	})
	await input.onInserted?.(inserted)
	return 'inserted'
}

export type OwnerCronEnablementBackfillCounts = {
	scanned: number
	inserted: number
	alreadyPresent: number
	skippedNoOwner: number
	skippedBadJobId: number
	skippedNotEnabled: number
	failed: number
}

export type OwnerCronEnablementBackfillOutcome = {
	jobId: string
	orgId: string
	jobName: string
	outcome: OwnerCronEnablementBackfillRowOutcome
	error?: string
}

export type OwnerCronEnablementBackfillResult = {
	dryRun: boolean
	counts: OwnerCronEnablementBackfillCounts
	nextCursor: string | null
	outcomes: Array<OwnerCronEnablementBackfillOutcome>
}

const defaultBackfillLimit = 100
const maxBackfillLimit = 500

/**
 * Idempotent page over jobs missing an owner cron enablement. Uses the jobs
 * store (JOBS binding in production) and writes enablements to APP_DB.
 * dryRun counts would-be inserts without writing.
 */
export async function backfillOwnerCronEnablements(input: {
	env: JobsDataEnv & { APP_DB: D1Database }
	dryRun?: boolean
	limit?: number
	cursor?: string | null
	now?: string
}): Promise<OwnerCronEnablementBackfillResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.min(
		Math.max(1, input.limit ?? defaultBackfillLimit),
		maxBackfillLimit,
	)
	const cursor = input.cursor ?? null
	const now = input.now ?? new Date().toISOString()
	const db = input.env.APP_DB

	const page = await jobsData(input.env).listJobsPage({
		afterId: cursor,
		limit,
	})

	const counts: OwnerCronEnablementBackfillCounts = {
		scanned: page.length,
		inserted: 0,
		alreadyPresent: 0,
		skippedNoOwner: 0,
		skippedBadJobId: 0,
		skippedNotEnabled: 0,
		failed: 0,
	}
	const outcomes: Array<OwnerCronEnablementBackfillOutcome> = []

	for (const row of page) {
		const orgId = row.user_id
		const jobId = row.id
		const jobName = row.name
		try {
			if (row.deleted_at != null || !row.record.enabled) {
				counts.skippedNotEnabled += 1
				outcomes.push({
					jobId,
					orgId: String(orgId),
					jobName,
					outcome: 'skipped_not_enabled',
				})
				continue
			}

			if (dryRun) {
				const packageId = packageIdFromJobId(jobId)
				if (!packageId) {
					counts.skippedBadJobId += 1
					outcomes.push({
						jobId,
						orgId: String(orgId),
						jobName,
						outcome: 'skipped_bad_job_id',
					})
					continue
				}
				const enablerUserId = await resolveOwnerPersonIdForCronEnablement(
					db,
					orgId,
				)
				if (!enablerUserId) {
					counts.skippedNoOwner += 1
					outcomes.push({
						jobId,
						orgId: String(orgId),
						jobName,
						outcome: 'skipped_no_owner',
					})
					continue
				}
				if (
					await ownerHasCronEnablementRow({
						db,
						orgId: String(orgId),
						jobId,
						jobName,
						enablerUserId: String(enablerUserId),
					})
				) {
					counts.alreadyPresent += 1
					outcomes.push({
						jobId,
						orgId: String(orgId),
						jobName,
						outcome: 'already_present',
					})
					continue
				}
				counts.inserted += 1
				outcomes.push({
					jobId,
					orgId: String(orgId),
					jobName,
					outcome: 'inserted',
				})
				continue
			}

			const outcome = await ensureOwnerCronEnablementForJob({
				db,
				orgId,
				jobId,
				jobName,
				now,
			})
			switch (outcome) {
				case 'inserted':
					counts.inserted += 1
					break
				case 'already_present':
					counts.alreadyPresent += 1
					break
				case 'skipped_no_owner':
					counts.skippedNoOwner += 1
					break
				case 'skipped_bad_job_id':
					counts.skippedBadJobId += 1
					break
				default: {
					const _exhaustive: never = outcome
					throw new Error(`Unexpected enablement outcome: ${_exhaustive}`)
				}
			}
			outcomes.push({
				jobId,
				orgId: String(orgId),
				jobName,
				outcome,
			})
		} catch (error) {
			counts.failed += 1
			outcomes.push({
				jobId,
				orgId: String(orgId),
				jobName,
				outcome: 'failed',
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const last = page.at(-1)
	return {
		dryRun,
		counts,
		nextCursor: page.length === limit && last ? last.id : null,
		outcomes,
	}
}

export const ownerCronEnablementBackfillLimitDefault = defaultBackfillLimit
export const ownerCronEnablementBackfillLimitMax = maxBackfillLimit
