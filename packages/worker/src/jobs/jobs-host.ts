import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type JobsHostContract,
	type RunDueJobsResult,
	type RunJobNowResult,
	type SettleHungDueJobsResult,
} from '@kody-internal/shared/jobs/rpc.ts'
import { type ScheduledLaneMessage } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import * as Sentry from '@sentry/cloudflare'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { getWorkerSentryOptions } from '#worker/sentry-options.ts'
import { runScheduledLaneWithFailureIsolation } from '#worker/scheduled/scheduled-lanes.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	runDueJobsForUser,
	runJobNow,
	settleHungDueJobsForUser,
} from './service.ts'
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
class JobsHostEntrypoint
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

	async settleHungDueJobsForUser(input: {
		userId: OwnerId
	}): Promise<SettleHungDueJobsResult> {
		return runWithDynamicWorkerEvaluationBudget(
			async () =>
				await settleHungDueJobsForUser({
					env: this.env,
					userId: input.userId,
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

/**
 * RPC methods on a bare `WorkerEntrypoint` run with no Sentry client, so
 * `Sentry.captureException` inside them (every `scheduled_lane_failed`,
 * including the DR staging watchdog) was dropped silently. Wrapping the class
 * gives each RPC call its own client and flush.
 */
export const JobsHost = Sentry.withSentry(
	// No DSN (including test envs) must stay disabled; `undefined` lets the
	// SDK fall back to `env.SENTRY_DSN` without our filters.
	(env: Env) => getWorkerSentryOptions(env) ?? { enabled: false },
	JobsHostEntrypoint,
)
export type JobsHost = JobsHostEntrypoint
