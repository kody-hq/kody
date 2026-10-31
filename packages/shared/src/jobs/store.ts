import {
	claimJobRow,
	countJobRowsBySourceId,
	countJobRowsForUser,
	deleteJobRow,
	disableExpiredJobRowsForUser,
	finalizeClaimedJobRow,
	getJobRowById,
	getJobRowInsights,
	getNextRunnableJobRow,
	insertJobRow,
	listAllJobStorageOwnerRows,
	listDueJobRows,
	listJobIdRowsForUser,
	listJobRowsByUserId,
	listJobRowsPage,
	listJobStorageIdRowsForUser,
	recordJobRunNowOutcomeRow,
	refreshPackageJobRowIdentity,
	renewClaimedJobRow,
	restoreJobRowsForUser,
	retryClaimedJobRow,
	softDeleteJobRowsForUser,
	sumJobRowsStorageBytesForUser,
	transferJobRowsOwner,
	updateJobRow,
	updateJobRowCallerContextJson,
	type JobCountBySourceId,
	type JobRow,
} from './repo.ts'
import { type JobRecord } from './types.ts'

/**
 * Coarse-grained jobs-data contract between the main worker and the jobs
 * worker (ADR 0016). The jobs worker owns the `jobs` table in its dedicated
 * D1 database and exposes these operations over a typed service binding
 * (`JobsService`). The main worker never queries the jobs table directly in
 * production; in local dev and tests without the binding it falls back to
 * {@link createD1JobsStore} over its own database (see `jobsStore` in the
 * main worker).
 *
 * Every operation is user-scoped (or an explicitly bounded cross-user
 * maintenance page) — implementations must preserve the per-user isolation
 * invariants of the underlying repo queries.
 */
export type JobsStore = {
	insertJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<void>
	updateJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<boolean>
	getJobById(input: { userId: string; jobId: string }): Promise<JobRow | null>
	listJobsForUser(input: { userId: string }): Promise<Array<JobRow>>
	listJobsPage(input: {
		afterId: string | null
		limit: number
	}): Promise<Array<JobRow>>
	listDueJobs(input: { userId: string; nowIso: string }): Promise<Array<JobRow>>
	getNextRunnableJob(input: {
		userId: string
		nowIso: string
	}): Promise<JobRow | null>
	claimJob(input: {
		userId: string
		jobId: string
		nowMs: number
		claimToken: string
	}): Promise<JobRow | null>
	renewClaimedJob(input: {
		userId: string
		jobId: string
		claimToken: string
		nowMs: number
	}): Promise<boolean>
	finalizeClaimedJob(input: {
		userId: string
		job: JobRecord
		claimToken: string
		scheduledFor: string
	}): Promise<boolean>
	retryClaimedJob(input: {
		userId: string
		jobId: string
		claimToken: string
		nextRunAt: string
	}): Promise<boolean>
	refreshPackageJobIdentity(input: {
		userId: string
		jobId: string
		sourceId: string
		publishedCommit: string | null
		callerContextJson: string
		updatedAt: string
	}): Promise<boolean>
	/**
	 * Records a Run now outcome without rewriting the job's settings, so edits
	 * that land while it runs survive. See `recordJobRunNowOutcomeRow`.
	 */
	recordJobRunNowOutcome(input: {
		userId: string
		jobId: string
		lastRunAt: string
		lastRunStatus: JobRecord['lastRunStatus']
		updatedAt: string
		nextRunAt: string
		scheduleJson: string
		timezone: string
	}): Promise<boolean>
	/**
	 * Narrow caller-context rewrite with an optimistic concurrency guard on
	 * the previous JSON. Does not touch schedule, claims, or retries.
	 */
	updateJobCallerContextJson(input: {
		userId: string
		jobId: string
		expectedCallerContextJson: string
		callerContextJson: string
		updatedAt: string
	}): Promise<boolean>
	deleteJob(input: { userId: string; jobId: string }): Promise<boolean>
	disableExpiredJobsForUser(input: {
		userId: string
		nowIso: string
	}): Promise<number>
	countJobsForUser(input: { userId: string }): Promise<number>
	/**
	 * Per-`source_id` job counts for one user. Used by profile signifiers
	 * so listing a profile does not load every job row.
	 */
	countJobsBySourceId(input: {
		userId: string
	}): Promise<Array<JobCountBySourceId>>
	/**
	 * Text-byte estimate of the user's job rows for the D1 storage quota
	 * (mirrors the main worker's per-table storage byte formula).
	 */
	sumJobsStorageBytesForUser(input: { userId: string }): Promise<number>
	/**
	 * Job ids owned by the user, for deriving job vector ids during account
	 * deletion. Vectors are written for live `jobs` rows.
	 */
	listJobIdsForUser(input: { userId: string }): Promise<Array<string>>
	/** Storage ids referenced by the user's jobs. */
	listJobStorageIdsForUser(input: { userId: string }): Promise<Array<string>>
	/**
	 * Platform-wide (userId, storageId) pairs across jobs. Operator-level DR
	 * inventory only — never expose on user-facing paths.
	 */
	listAllJobStorageOwners(): Promise<
		Array<{ userId: string; storageId: string }>
	>
	/** Platform-wide job totals for admin insights. */
	getJobInsights(): Promise<{ total: number; enabled: number }>
	/** Deletes every job row for the user. */
	purgeUserJobsData(input: { userId: string }): Promise<void>
	/** Soft-delete live jobs for an org/user owner (Teams P7). */
	softDeleteJobsForUser(input: {
		userId: string
		deletedAt: string
	}): Promise<number>
	/** Restore jobs soft-deleted together at `deletedAt`. */
	restoreJobsForUser(input: {
		userId: string
		deletedAt: string
		restoredAt: string
	}): Promise<number>
	/**
	 * Operator org resource transfer: re-point live, unclaimed jobs from one
	 * owner to another in one batch, rewriting each caller context. Refuses
	 * (and changes nothing) unless every listed job matches.
	 */
	transferJobsOwner(input: {
		fromUserId: string
		toUserId: string
		jobs: Array<{ jobId: string; callerContextJson: string }>
		updatedAt: string
	}): Promise<{ transferred: number }>
}

/** D1-backed {@link JobsStore} used by the jobs worker (and dev/test fallback). */
export function createD1JobsStore(db: D1Database): JobsStore {
	return {
		insertJob: async (input) => {
			await insertJobRow({ db, ...input })
		},
		updateJob: (input) => updateJobRow({ db, ...input }),
		getJobById: (input) => getJobRowById(db, input.userId, input.jobId),
		listJobsForUser: (input) => listJobRowsByUserId(db, input.userId),
		listJobsPage: (input) => listJobRowsPage(db, input),
		listDueJobs: (input) => listDueJobRows(db, input.userId, input.nowIso),
		getNextRunnableJob: (input) =>
			getNextRunnableJobRow(db, input.userId, input.nowIso),
		claimJob: (input) =>
			claimJobRow({
				db,
				userId: input.userId,
				jobId: input.jobId,
				now: new Date(input.nowMs),
				claimToken: input.claimToken,
			}),
		renewClaimedJob: (input) => renewClaimedJobRow({ db, ...input }),
		finalizeClaimedJob: (input) => finalizeClaimedJobRow({ db, ...input }),
		retryClaimedJob: (input) => retryClaimedJobRow({ db, ...input }),
		refreshPackageJobIdentity: (input) =>
			refreshPackageJobRowIdentity({ db, ...input }),
		recordJobRunNowOutcome: (input) =>
			recordJobRunNowOutcomeRow({ db, ...input }),
		updateJobCallerContextJson: (input) =>
			updateJobRowCallerContextJson({ db, ...input }),
		deleteJob: (input) => deleteJobRow(db, input.userId, input.jobId),
		disableExpiredJobsForUser: (input) =>
			disableExpiredJobRowsForUser({ db, ...input }),
		countJobsForUser: (input) => countJobRowsForUser(db, input.userId),
		countJobsBySourceId: (input) => countJobRowsBySourceId(db, input.userId),
		sumJobsStorageBytesForUser: (input) =>
			sumJobRowsStorageBytesForUser(db, input.userId),
		listJobIdsForUser: (input) => listJobIdRowsForUser(db, input.userId),
		listJobStorageIdsForUser: (input) =>
			listJobStorageIdRowsForUser(db, input.userId),
		listAllJobStorageOwners: () => listAllJobStorageOwnerRows(db),
		getJobInsights: () => getJobRowInsights(db),
		purgeUserJobsData: async (input) => {
			await db
				.prepare(`DELETE FROM jobs WHERE user_id = ?`)
				.bind(input.userId)
				.run()
		},
		softDeleteJobsForUser: (input) =>
			softDeleteJobRowsForUser({ db, ...input }),
		restoreJobsForUser: (input) => restoreJobRowsForUser({ db, ...input }),
		transferJobsOwner: (input) => transferJobRowsOwner({ db, ...input }),
	}
}
