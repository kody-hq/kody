import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import { isDurableObjectIsolateResetMessage } from '#worker/sentry-options.ts'
import { isStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import {
	deriveRequestContext,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import {
	type RunRecord,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	type JobExecutionOutcome,
	type PersistedJobCallerContext,
} from './types.ts'

export const jobRetryBaseDelayMs = 5_000
export const jobRetryMaximumDelayMs = 5 * 60 * 1_000

export class TransientJobExecutionError extends Error {
	override readonly name = 'TransientJobExecutionError'
}

export function buildScheduledJobIdempotencyKey(input: {
	jobId: string
	scheduledFor: string
}) {
	return `scheduled-job:${input.jobId}:${input.scheduledFor}`
}

/**
 * D1 blips, Durable Object isolate resets (including "instance is no longer
 * active"), and storage-estimate misses. Sandbox execute often returns these
 * on `result.error` instead of throwing; claimed scheduled runs must promote
 * that string through this helper so JobManager backs off the same occurrence.
 */
export function isTransientJobExecutionError(error: unknown) {
	return (
		error instanceof TransientJobExecutionError ||
		isRetryableD1LockError(error) ||
		errorCauseChainIncludes(error, isDurableObjectIsolateResetMessage) ||
		isStorageEstimateReadError(error)
	)
}

export function markPreExecutionTransientError(error: unknown): unknown {
	if (
		error instanceof TransientJobExecutionError ||
		!isTransientJobExecutionError(error)
	) {
		return error
	}
	const message = error instanceof Error ? error.message : String(error)
	return new TransientJobExecutionError(message, { cause: error })
}

export function computeJobRetryAt(input: { now: Date; retryCount: number }) {
	const delayMs = Math.min(
		jobRetryMaximumDelayMs,
		jobRetryBaseDelayMs * 2 ** Math.max(0, input.retryCount),
	)
	return new Date(input.now.valueOf() + delayMs).toISOString()
}

export function replayScheduledJobRun(run: RunRecord): JobExecutionOutcome {
	const finishedAt = run.finishedAt ?? run.startedAt
	switch (run.status) {
		case 'success':
			return {
				execution: {
					ok: true,
					result: run.metadata['result'],
					logs: [],
				},
				startedAt: run.startedAt,
				finishedAt,
				durationMs: run.durationMs ?? 0,
			}
		case 'error':
			return {
				execution: {
					ok: false,
					error:
						run.errorMessage ??
						'The retained scheduled job run ended with an unknown error.',
					logs: [],
				},
				startedAt: run.startedAt,
				finishedAt,
				durationMs: run.durationMs ?? 0,
			}
		case 'running':
			throw new TransientJobExecutionError(
				'A previous execution still owns this scheduled occurrence; it will be retried without duplicate execution.',
			)
		default: {
			const exhaustive: never = run.status
			throw new Error(`Unhandled run status: ${String(exhaustive)}`)
		}
	}
}

export async function executeOrReplayScheduledJobRun(input: {
	claim:
		| { claimed: true; handle: RunRecordHandle }
		| { claimed: false; run: RunRecord }
		| null
	execute: (handle: RunRecordHandle) => Promise<JobExecutionOutcome>
}) {
	if (!input.claim) {
		throw new TransientJobExecutionError(
			'Unable to claim scheduled job idempotency key; RUN_LOG is unavailable.',
		)
	}
	if (!input.claim.claimed) {
		return replayScheduledJobRun(input.claim.run)
	}
	return await input.execute(input.claim.handle)
}

/**
 * Use the blob stored on the job row. Execution rebinds identity to that
 * row's owner, so a legacy blob whose user is a member person (not the org
 * id) still runs. A missing blob stays missing.
 */
export function resolveScheduledJobCallerContext(input: {
	callerContext: PersistedJobCallerContext | null
}) {
	return input.callerContext
}

/**
 * Request for a scheduled tick's run record. Prefer the job row's persisted
 * caller when present; otherwise stamp from the enablement on `source` so
 * legacy / package-synced rows still record started_by as the enabler.
 */
export function resolveScheduledJobRunRequest(input: {
	callerContext: PersistedJobCallerContext | null
	source: RequestSource
}): RequestContext | null {
	const caller = resolveScheduledJobCallerContext({
		callerContext: input.callerContext,
	})
	const enablement =
		input.source.kind === 'schedule' ? input.source.enablement : undefined
	const person = caller?.user ?? enablement?.enabler ?? null
	if (!person) return null
	return deriveRequestContext({
		user: person,
		source: input.source,
	})
}
