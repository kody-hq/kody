import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type JobManagerDebugState } from '@kody-internal/shared/jobs/manager-debug.ts'
import { resolveJobManagerAlarmState } from '@kody-internal/shared/jobs/manager-state.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
	summarizeSchedulerJobOutcomes,
} from '@kody-internal/shared/jobs/scheduler-logging.ts'
import { type JobRepoCheckPolicy } from '@kody-internal/shared/jobs/types.ts'
import { DurableObject } from 'cloudflare:workers'
import { type JobsWorkerEnv } from './env.ts'
import {
	tryRearmAlarmForRetryableD1Failure,
	trySettleHungRunDueJobsFailure,
} from './manager-alarm-deferral.ts'
import { buildSentryOptions } from './sentry-options.ts'
import { getNextRunnableJob } from './store.ts'

const userIdStorageKey = 'user-id'

/**
 * Atomically rearm while keeping any earlier wake already scheduled on this
 * DO (for example a nearer job armed via syncAlarm). `setAlarm` replaces the
 * single DO alarm; without a get-then-set under concurrency block we could
 * push a nearer schedule out to the D1 backoff.
 */
async function rearmAlarmPreservingEarlier(
	ctx: DurableObjectState,
	atMs: number,
): Promise<void> {
	await ctx.blockConcurrencyWhile(async () => {
		const currentAlarmAt = await ctx.storage.getAlarm()
		if (currentAlarmAt == null || currentAlarmAt > atMs) {
			await ctx.storage.setAlarm(atMs)
		}
	})
}

/**
 * When more due jobs remain after an alarm run (each run processes at most
 * `maxDueJobsPerAlarm` jobs), the resync arms a near-immediate follow-up
 * alarm instead of one at the (already past) next_run_at so backlogs drain
 * across multiple short invocations.
 */
const jobBacklogRearmDelayMs = 1_000

/**
 * Per-user job scheduler Durable Object. Moved from the main worker script
 * (`kody`) via a script-transfer migration (ADR 0016) so each user's existing
 * storage (stored user id, alarm) carried over. Owns alarm arming against the
 * jobs D1 database; actual job execution happens in the main worker through
 * the HOST service binding (`JobsHost`).
 */
export class JobManagerBase extends DurableObject<JobsWorkerEnv> {
	async purgeUser(input: { userId: string }) {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Job manager requires a non-empty userId.')
		}
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort: deleteAll below still removes persisted scheduler state.
		})
		await this.ctx.storage.deleteAll()
		logJobSchedulerEvent({
			event: 'purge_user',
			userId,
			reason: 'account_deletion',
		})
		return {
			ok: true as const,
			userId,
		}
	}

	async syncAlarm(input: {
		userId: string
		source?: 'alarm' | 'rpc' | 'run_now'
	}) {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Job manager requires a non-empty userId.')
		}
		try {
			await this.ctx.storage.put(userIdStorageKey, userId)
			const currentAlarmAt = await this.ctx.storage.getAlarm()
			const nextJob = await getNextRunnableJob({
				env: this.env,
				userId,
			})
			if (!nextJob) {
				await this.ctx.storage.deleteAlarm()
				logJobSchedulerEvent({
					event: 'sync_alarm',
					userId,
					currentAlarmAt:
						currentAlarmAt == null
							? null
							: new Date(currentAlarmAt).toISOString(),
					nextJobId: null,
					nextRunAt: null,
					reason: 'no_runnable_job',
				})
				return {
					ok: true as const,
					userId,
					nextRunAt: null,
				}
			}
			const nextRunAtMs = new Date(nextJob.nextRunAt).valueOf()
			const backlogRemains = nextRunAtMs <= Date.now()
			const alarmAtMs = backlogRemains
				? Date.now() + jobBacklogRearmDelayMs
				: nextRunAtMs
			await this.ctx.storage.setAlarm(alarmAtMs)
			logJobSchedulerEvent({
				event: 'sync_alarm',
				userId,
				currentAlarmAt:
					currentAlarmAt == null
						? null
						: new Date(currentAlarmAt).toISOString(),
				nextJobId: nextJob.id,
				nextRunAt: nextJob.nextRunAt,
				reason: backlogRemains
					? 'backlog_rearmed'
					: currentAlarmAt === nextRunAtMs
						? 'alarm_unchanged'
						: 'alarm_armed',
			})
			return {
				ok: true as const,
				userId,
				nextRunAt: nextJob.nextRunAt,
			}
		} catch (error) {
			logJobSchedulerError({
				event: 'sync_alarm_failed',
				userId,
				source: input.source ?? 'rpc',
				...schedulerErrorFields(error),
			})
			throw error
		}
	}

	async getDebugState(input: {
		userId: string
	}): Promise<JobManagerDebugState> {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Job manager requires a non-empty userId.')
		}
		const [storedUserId, alarmTimestamp, nextJob] = await Promise.all([
			this.ctx.storage.get<string>(userIdStorageKey),
			this.ctx.storage.getAlarm(),
			getNextRunnableJob({
				env: this.env,
				userId,
			}),
		])
		const nextRunnableRunAt = nextJob?.nextRunAt ?? null
		const { alarmScheduledFor, alarmInSync, status } =
			resolveJobManagerAlarmState({
				alarmTimestamp,
				nextRunnableRunAt,
			})
		return {
			bindingAvailable: true,
			status,
			storedUserId: storedUserId ?? null,
			alarmScheduledFor,
			nextRunnableJobId: nextJob?.id ?? null,
			nextRunnableRunAt,
			alarmInSync,
		}
	}

	async exportUser(input: { userId: string }): Promise<JobManagerDebugState> {
		return this.getDebugState(input)
	}

	async alarm(alarmInfo?: {
		retryCount?: number
		isRetry?: boolean
	}): Promise<void> {
		const userId = await this.ctx.storage.get<string>(userIdStorageKey)
		if (!userId) {
			await this.ctx.storage.deleteAlarm()
			logJobSchedulerEvent({
				event: 'alarm_fired',
				reason: 'missing_user_id',
				retryCount: alarmInfo?.retryCount,
				isRetry: alarmInfo?.isRetry,
			})
			return
		}
		logJobSchedulerEvent({
			event: 'alarm_fired',
			userId,
			retryCount: alarmInfo?.retryCount,
			isRetry: alarmInfo?.isRetry,
		})
		try {
			const result = await this.env.HOST.runDueJobsForUser({ userId })
			logJobSchedulerEvent({
				event: 'run_due_jobs_completed',
				userId,
				dueJobCount: result.dueJobCount,
				successCount: result.successCount,
				errorCount: result.errorCount,
				reason:
					result.dueJobCount === 0 ? 'no_due_jobs_found' : 'processed_due_jobs',
				...summarizeSchedulerJobOutcomes(result.jobOutcomes),
			})
		} catch (error) {
			logJobSchedulerError({
				event: 'alarm_run_due_jobs_failed',
				userId,
				retryCount: alarmInfo?.retryCount,
				isRetry: alarmInfo?.isRetry,
				...schedulerErrorFields(error),
			})
			if (
				await tryRearmAlarmForRetryableD1Failure({
					setAlarm: (atMs) => rearmAlarmPreservingEarlier(this.ctx, atMs),
					getAlarm: () => this.ctx.storage.getAlarm(),
					userId,
					error,
					phase: 'run_due_jobs',
					retryCount: alarmInfo?.retryCount,
					isRetry: alarmInfo?.isRetry,
				})
			) {
				return
			}
			if (
				await trySettleHungRunDueJobsFailure({
					settleHungDueJobsForUser: (args) =>
						this.env.HOST.settleHungDueJobsForUser(args),
					userId,
					error,
					retryCount: alarmInfo?.retryCount,
					isRetry: alarmInfo?.isRetry,
				})
			) {
				// Fall through to syncAlarm so the next wake is armed; do not
				// rethrow or Cloudflare will retry the same hung alarm.
			} else {
				throw error
			}
		}
		try {
			await this.syncAlarm({ userId, source: 'alarm' })
		} catch (error) {
			logJobSchedulerError({
				event: 'alarm_resync_failed',
				userId,
				retryCount: alarmInfo?.retryCount,
				isRetry: alarmInfo?.isRetry,
				...schedulerErrorFields(error),
			})
			if (
				await tryRearmAlarmForRetryableD1Failure({
					setAlarm: (atMs) => rearmAlarmPreservingEarlier(this.ctx, atMs),
					getAlarm: () => this.ctx.storage.getAlarm(),
					userId,
					error,
					phase: 'sync_alarm',
					retryCount: alarmInfo?.retryCount,
					isRetry: alarmInfo?.isRetry,
				})
			) {
				return
			}
			throw error
		}
	}

	async runNow(input: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}) {
		let result:
			| Awaited<ReturnType<JobsWorkerEnv['HOST']['runJobNow']>>
			| undefined
		let originalError: unknown
		try {
			result = await this.env.HOST.runJobNow({
				userId: input.userId,
				jobId: input.jobId,
				callerContext: input.callerContext ?? null,
				repoCheckPolicyOverride: input.repoCheckPolicyOverride ?? null,
			})
		} catch (error) {
			originalError = error
		}
		try {
			await this.syncAlarm({ userId: input.userId, source: 'run_now' })
		} catch (syncError) {
			console.error('[JobManager.runNow] failed to sync job alarm', {
				userId: input.userId,
				jobId: input.jobId,
				syncError,
			})
		}
		if (originalError) {
			throw originalError
		}
		return result!
	}
}

export const JobManager = Sentry.instrumentDurableObjectWithSentry(
	(env: JobsWorkerEnv) => buildSentryOptions(env),
	JobManagerBase,
)
