import { type McpCallerContext } from '../chat.ts'
import { type OwnerId } from '../owner-person-ids.ts'
import { type JobManagerDebugState } from './manager-debug.ts'
import {
	type ScheduledLaneMessage,
	type ScheduledLaneOutcome,
} from './scheduled-lanes.ts'
import { type SchedulerJobOutcomeLog } from './scheduler-logging.ts'
import { type JobsStore } from './store.ts'
import {
	type JobExecutionResult,
	type JobRepoCheckPolicy,
	type JobView,
} from './types.ts'

/**
 * Service-binding contract the jobs worker exposes to the main worker
 * (`JOBS` binding → `JobsService` entrypoint, ADR 0016). It is the jobs
 * store plus the JobManager Durable Object scheduling operations that used to
 * be direct DO RPC from the main worker.
 */
export type JobsServiceContract = JobsStore & {
	syncAlarm(input: {
		userId: OwnerId
	}): Promise<{ ok: true; userId: string; nextRunAt: string | null }>
	getDebugState(input: { userId: OwnerId }): Promise<JobManagerDebugState>
	exportUser(input: { userId: OwnerId }): Promise<JobManagerDebugState>
	purgeUser(input: {
		userId: OwnerId
	}): Promise<{ ok: true; userId: string; purged: boolean }>
	runJobNow(input: {
		userId: OwnerId
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<RunJobNowResult>
	/**
	 * Resends a parked `kody-scheduled-dispatch-dlq` body to the scheduled
	 * dispatch queue (the jobs worker owns that producer). Rejects bodies that
	 * are not scheduled lane messages.
	 */
	replayScheduledDispatchMessage(input: {
		body: unknown
	}): Promise<{ ok: true; lane: string }>
}

export type RunDueJobsResult = {
	dueJobCount: number
	successCount: number
	errorCount: number
	jobOutcomes: Array<SchedulerJobOutcomeLog>
}

export type RunJobNowResult = {
	job: JobView
	execution: JobExecutionResult
}

/**
 * Service-binding contract the main worker exposes to the jobs worker
 * (`HOST` binding → `JobsHost` entrypoint, ADR 0016). Job execution and the
 * platform scheduled lanes stay in the main worker — they are welded to the
 * package runtime, run records, entitlements, and email subsystems — so the
 * jobs worker calls back through this deliberately small surface.
 */
export type SettleHungDueJobsResult = {
	settledCount: number
	jobOutcomes: Array<SchedulerJobOutcomeLog>
}

export type JobsHostContract = {
	/** Execute all currently due jobs for one user (JobManager alarm body). */
	runDueJobsForUser(input: { userId: string }): Promise<RunDueJobsResult>
	/**
	 * After Cloudflare cancels a hung `runDueJobsForUser` request, settle any
	 * actively claimed jobs for the user as visible failures on a fresh RPC.
	 */
	settleHungDueJobsForUser(input: {
		userId: string
	}): Promise<SettleHungDueJobsResult>
	/** Execute a single job immediately (JobManager `runNow` body). */
	runJobNow(input: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<RunJobNowResult>
	/** Execute one platform scheduled lane with failure isolation. */
	runScheduledLane(message: ScheduledLaneMessage): Promise<ScheduledLaneOutcome>
}
