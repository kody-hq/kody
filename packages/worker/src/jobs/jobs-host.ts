import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type JobsHostContract,
	type RunDueJobsResult,
	type RunJobNowResult,
} from '@kody-internal/shared/jobs/rpc.ts'
import { type ScheduledLaneMessage } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { runScheduledLaneWithFailureIsolation } from '#worker/scheduled/scheduled-lanes.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#worker/dynamic-worker-evaluation-budget.ts'
import { runDueJobsForUser, runJobNow } from './service.ts'
import { type JobRepoCheckPolicy } from './types.ts'

/**
 * `JobsHost` — the main worker's callback entrypoint for the jobs worker
 * (ADR 0016). The jobs worker owns the cron trigger, the scheduled dispatch
 * queue, and the JobManager Durable Object; when a JobManager alarm fires or
 * a run-now request arrives it calls back here for the actual job execution
 * (package invocation, email, storage, entitlements, run records — all of
 * which live in the main worker). Platform scheduled lanes the jobs worker
 * does not own are forwarded through `runScheduledLane`.
 */
export class JobsHost
	extends WorkerEntrypoint<Env>
	implements JobsHostContract
{
	async runDueJobsForUser(input: {
		userId: OwnerId
	}): Promise<RunDueJobsResult> {
		return runWithDynamicWorkerEvaluationBudget(
			async () =>
				await runDueJobsForUser({
					env: this.env,
					userId: input.userId,
					// Host lifecycle owns meter finalization (and other deferred
					// side effects). Claimed scheduled runs finish the run record
					// before this RPC returns; waitUntil only retains promises.
					waitUntil: (promise) => this.ctx.waitUntil(promise),
				}),
		)
	}

	async runJobNow(input: {
		userId: OwnerId
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<RunJobNowResult> {
		return runWithDynamicWorkerEvaluationBudget(
			async () =>
				await runJobNow({
					env: this.env,
					userId: input.userId,
					jobId: input.jobId,
					callerContext: input.callerContext ?? null,
					repoCheckPolicyOverride: input.repoCheckPolicyOverride ?? null,
					waitUntil: (promise) => this.ctx.waitUntil(promise),
				}),
		)
	}

	async runScheduledLane(
		message: ScheduledLaneMessage,
	): Promise<'completed' | 'd1_lock_contention' | 'failed'> {
		return runWithDynamicWorkerEvaluationBudget(
			async () =>
				await runScheduledLaneWithFailureIsolation({
					env: this.env,
					message,
				}),
		)
	}
}
