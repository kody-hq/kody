import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type JobManagerDebugState } from '@kody-internal/shared/jobs/manager-debug.ts'
import {
	type JobsServiceContract,
	type JobsHostContract,
} from '@kody-internal/shared/jobs/rpc.ts'
import {
	type JobCountBySourceId,
	type JobRow,
} from '@kody-internal/shared/jobs/repo.ts'
import {
	type JobRecord,
	type JobRepoCheckPolicy,
} from '@kody-internal/shared/jobs/types.ts'
import { parseScheduledLaneMessage } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { type JobsWorkerEnv } from './env.ts'
import { jobManagerStub } from './manager.ts'
import { jobsStore } from './store.ts'

/**
 * `JobsService` — the coarse-grained RPC surface the main worker reaches
 * through its JOBS service binding (ADR 0016). Implements
 * {@link JobsServiceContract}: the jobs-data store over the dedicated jobs D1
 * plus the JobManager Durable Object scheduling operations. Every operation
 * is user-scoped; userId always comes from the caller (the main worker
 * resolves it from the authenticated session/caller context).
 */
export class JobsService
	extends WorkerEntrypoint<JobsWorkerEnv>
	implements JobsServiceContract
{
	async insertJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<void> {
		await jobsStore(this.env).insertJob(input)
	}

	async updateJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<boolean> {
		return jobsStore(this.env).updateJob(input)
	}

	async getJobById(input: {
		userId: string
		jobId: string
	}): Promise<JobRow | null> {
		return jobsStore(this.env).getJobById(input)
	}

	async listJobsForUser(input: { userId: string }): Promise<Array<JobRow>> {
		return jobsStore(this.env).listJobsForUser(input)
	}

	async listJobsPage(input: {
		afterId: string | null
		limit: number
	}): Promise<Array<JobRow>> {
		return jobsStore(this.env).listJobsPage(input)
	}

	async listDueJobs(input: {
		userId: string
		nowIso: string
	}): Promise<Array<JobRow>> {
		return jobsStore(this.env).listDueJobs(input)
	}

	async getNextRunnableJob(input: {
		userId: string
		nowIso: string
	}): Promise<JobRow | null> {
		return jobsStore(this.env).getNextRunnableJob(input)
	}

	async claimJob(input: {
		userId: string
		jobId: string
		nowMs: number
		claimToken: string
	}): Promise<JobRow | null> {
		return jobsStore(this.env).claimJob(input)
	}

	async renewClaimedJob(input: {
		userId: string
		jobId: string
		claimToken: string
		nowMs: number
	}): Promise<boolean> {
		return jobsStore(this.env).renewClaimedJob(input)
	}

	async finalizeClaimedJob(input: {
		userId: string
		job: JobRecord
		claimToken: string
		scheduledFor: string
	}): Promise<boolean> {
		return jobsStore(this.env).finalizeClaimedJob(input)
	}

	async retryClaimedJob(input: {
		userId: string
		jobId: string
		claimToken: string
		nextRunAt: string
	}): Promise<boolean> {
		return jobsStore(this.env).retryClaimedJob(input)
	}

	async refreshPackageJobIdentity(input: {
		userId: string
		jobId: string
		sourceId: string
		publishedCommit: string | null
		callerContextJson: string
		updatedAt: string
	}): Promise<boolean> {
		return jobsStore(this.env).refreshPackageJobIdentity(input)
	}

	async updateJobCallerContextJson(input: {
		userId: string
		jobId: string
		expectedCallerContextJson: string
		callerContextJson: string
		updatedAt: string
	}): Promise<boolean> {
		return jobsStore(this.env).updateJobCallerContextJson(input)
	}

	async deleteJob(input: { userId: string; jobId: string }): Promise<boolean> {
		return jobsStore(this.env).deleteJob(input)
	}

	async disableExpiredJobsForUser(input: {
		userId: string
		nowIso: string
	}): Promise<number> {
		return jobsStore(this.env).disableExpiredJobsForUser(input)
	}

	async countJobsForUser(input: { userId: string }): Promise<number> {
		return jobsStore(this.env).countJobsForUser(input)
	}

	async countJobsBySourceId(input: {
		userId: string
	}): Promise<Array<JobCountBySourceId>> {
		return jobsStore(this.env).countJobsBySourceId(input)
	}

	async sumJobsStorageBytesForUser(input: { userId: string }): Promise<number> {
		return jobsStore(this.env).sumJobsStorageBytesForUser(input)
	}

	async listJobIdsForUser(input: { userId: string }): Promise<Array<string>> {
		return jobsStore(this.env).listJobIdsForUser(input)
	}

	async listJobStorageIdsForUser(input: {
		userId: string
	}): Promise<Array<string>> {
		return jobsStore(this.env).listJobStorageIdsForUser(input)
	}

	async listAllJobStorageOwners(): Promise<
		Array<{ userId: string; storageId: string }>
	> {
		return jobsStore(this.env).listAllJobStorageOwners()
	}

	async getJobInsights(): Promise<{ total: number; enabled: number }> {
		return jobsStore(this.env).getJobInsights()
	}

	async purgeUserJobsData(input: { userId: string }): Promise<void> {
		await jobsStore(this.env).purgeUserJobsData(input)
	}

	async softDeleteJobsForUser(input: {
		userId: string
		deletedAt: string
	}): Promise<number> {
		return jobsStore(this.env).softDeleteJobsForUser(input)
	}

	async restoreJobsForUser(input: {
		userId: string
		deletedAt: string
		restoredAt: string
	}): Promise<number> {
		return jobsStore(this.env).restoreJobsForUser(input)
	}

	async transferJobsOwner(input: {
		fromUserId: string
		toUserId: string
		jobs: Array<{ jobId: string; callerContextJson: string }>
		updatedAt: string
	}): Promise<{ transferred: number }> {
		return jobsStore(this.env).transferJobsOwner(input)
	}

	async syncAlarm(input: {
		userId: OwnerId
	}): Promise<{ ok: true; userId: string; nextRunAt: string | null }> {
		return jobManagerStub(this.env, input.userId).syncAlarm({
			userId: input.userId,
			source: 'rpc',
		})
	}

	async getDebugState(input: {
		userId: OwnerId
	}): Promise<JobManagerDebugState> {
		return jobManagerStub(this.env, input.userId).getDebugState(input)
	}

	async exportUser(input: { userId: OwnerId }): Promise<JobManagerDebugState> {
		return jobManagerStub(this.env, input.userId).exportUser(input)
	}

	/**
	 * Account-deletion hook: removes every jobs-database row for the user and
	 * purges the JobManager Durable Object storage (including its alarm).
	 */
	async purgeUser(input: {
		userId: OwnerId
	}): Promise<{ ok: true; userId: string; purged: boolean }> {
		const trimmed = input.userId.trim()
		if (!trimmed) {
			throw new Error('Jobs purge requires a non-empty userId.')
		}
		// Purge has always named the JobManager with the trimmed id. An
		// OwnerId from the caller is already trimmed; keep the trimmed bytes
		// when a stored id has surrounding spaces.
		const userId =
			trimmed === input.userId ? input.userId : (trimmed as OwnerId)
		await jobsStore(this.env).purgeUserJobsData({ userId })
		await jobManagerStub(this.env, userId).purgeUser({ userId })
		return { ok: true as const, userId, purged: true }
	}

	async runJobNow(input: {
		userId: OwnerId
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<Awaited<ReturnType<JobsHostContract['runJobNow']>>> {
		return jobManagerStub(this.env, input.userId).runNow({
			userId: input.userId,
			jobId: input.jobId,
			callerContext: input.callerContext ?? null,
			repoCheckPolicyOverride: input.repoCheckPolicyOverride ?? null,
		})
	}

	async replayScheduledDispatchMessage(input: {
		body: unknown
	}): Promise<{ ok: true; lane: string }> {
		const message = parseScheduledLaneMessage(input.body)
		if (!message) {
			throw new Error('The parked body is not a scheduled lane message.')
		}
		const queue = this.env.SCHEDULED_DISPATCH_QUEUE
		if (!queue) {
			throw new Error(
				'SCHEDULED_DISPATCH_QUEUE is not bound in this environment.',
			)
		}
		await queue.send(message)
		return { ok: true as const, lane: message.lane }
	}
}
