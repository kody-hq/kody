import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	buildScheduledJobIdempotencyKey,
	computeJobRetryAt,
	executeOrReplayScheduledJobRun,
	isTransientJobExecutionError,
	markPreExecutionTransientError,
	resolveScheduledJobCallerContext,
	resolveScheduledJobRunRequest,
	TransientJobExecutionError,
} from './execution-safety.ts'
import { type PersistedJobCallerContext } from './types.ts'

const scheduledFor = '2026-07-29T12:00:00.000Z'

function claimedByOtherAttempt(
	run: { id: string; status: 'success' | 'running' } & Record<string, unknown>,
) {
	return {
		claimed: false as const,
		run: {
			surface: 'job',
			name: 'Safe job',
			packageId: null,
			kodyId: null,
			sourceId: 'source-1',
			publishedCommit: null,
			storageId: 'job:job-1',
			jobId: 'job-1',
			workflowId: null,
			invocationId: null,
			sessionId: null,
			idempotencyKey: buildScheduledJobIdempotencyKey({
				jobId: 'job-1',
				scheduledFor,
			}),
			parentRunId: null,
			startedAt: scheduledFor,
			errorName: null,
			errorMessage: null,
			logCount: 0,
			...run,
		},
	} as Parameters<typeof executeOrReplayScheduledJobRun>[0]['claim']
}

test('terminal scheduled run replay returns retained result without executing', async () => {
	const execute = vi.fn()
	const outcome = await executeOrReplayScheduledJobRun({
		claim: claimedByOtherAttempt({
			id: 'run-1',
			status: 'success',
			finishedAt: '2026-07-29T12:00:01.000Z',
			durationMs: 1_000,
			metadata: { scheduledFor, result: { retained: true } },
		}),
		execute,
	})

	expect(execute).not.toHaveBeenCalled()
	expect(outcome).toEqual({
		execution: { ok: true, result: { retained: true }, logs: [] },
		startedAt: scheduledFor,
		finishedAt: '2026-07-29T12:00:01.000Z',
		durationMs: 1_000,
	})

	await expect(
		executeOrReplayScheduledJobRun({ claim: null, execute }),
	).rejects.toThrow(
		'Unable to claim scheduled job idempotency key; RUN_LOG is unavailable.',
	)
	expect(execute).not.toHaveBeenCalled()
})

test('running scheduled run backs off without duplicate execution', async () => {
	const execute = vi.fn()
	await expect(
		executeOrReplayScheduledJobRun({
			claim: claimedByOtherAttempt({
				id: 'run-running',
				status: 'running',
				finishedAt: null,
				durationMs: null,
				metadata: { scheduledFor },
			}),
			execute,
		}),
	).rejects.toBeInstanceOf(TransientJobExecutionError)
	expect(execute).not.toHaveBeenCalled()
})

test('scheduled runs keep a legacy caller context whose user is not the row owner', () => {
	const callerContext = {
		user: { userId: personIdFromStored('person-1') },
	} as PersistedJobCallerContext
	expect(resolveScheduledJobCallerContext({ callerContext })).toBe(
		callerContext,
	)
	expect(resolveScheduledJobCallerContext({ callerContext: null })).toBeNull()
})

test('scheduled run request stamps started_by from enablement when caller blob has no user', () => {
	const enabler = {
		userId: personIdFromStored('enabler-1'),
		username: 'enabler',
	}
	const fromEnablement = resolveScheduledJobRunRequest({
		callerContext: null,
		source: {
			kind: 'schedule',
			jobId: 'job-1',
			enablement: {
				id: 'en-1',
				enabler,
				role: 'member',
			},
		},
	})
	expect(fromEnablement).toMatchObject({
		actor: { userId: enabler.userId, username: 'enabler' },
		credential: { kind: 'schedule' },
	})
	expect(
		resolveScheduledJobRunRequest({
			callerContext: null,
			source: { kind: 'schedule', jobId: 'job-1' },
		}),
	).toBeNull()
	const callerUser = {
		userId: personIdFromStored('caller-1'),
		username: 'caller',
	}
	expect(
		resolveScheduledJobRunRequest({
			callerContext: { user: callerUser } as PersistedJobCallerContext,
			source: {
				kind: 'schedule',
				jobId: 'job-1',
				enablement: {
					id: 'en-1',
					enabler,
					role: 'member',
				},
			},
		}),
	).toMatchObject({
		// Enablement still supplies the schedule actor; caller supplies org binding.
		actor: { userId: enabler.userId },
		credential: { kind: 'schedule' },
	})
})

test('transient platform failures are classified for same-occurrence backoff', () => {
	const now = new Date(scheduledFor)
	for (const [message, transient] of [
		['D1_ERROR: Network connection lost.', true],
		["Durable Object's isolate exceeded its memory limit and was reset.", true],
		[
			'Internal error in Durable Object storage caused object to be reset; reference = 849rqmf61lg3qbmtb3j6moc4',
			true,
		],
		[
			'Durable Object storage operation exceeded timeout which caused object to be reset.',
			true,
		],
		[
			'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
			true,
		],
		[
			'Unable to verify the storage byte entitlement because the bucket estimate for storageId "package:1" could not be read after 4 attempts.',
			true,
		],
		['user code failed', false],
	] as const) {
		expect(isTransientJobExecutionError(new Error(message))).toBe(transient)
	}
	expect(
		markPreExecutionTransientError(
			new Error('D1_ERROR: Network connection lost.'),
		),
	).toBeInstanceOf(TransientJobExecutionError)
	expect(
		markPreExecutionTransientError(new Error('user code failed')),
	).not.toBeInstanceOf(TransientJobExecutionError)
	expect(computeJobRetryAt({ now, retryCount: 0 })).toBe(
		'2026-07-29T12:00:05.000Z',
	)
	expect(computeJobRetryAt({ now, retryCount: 3 })).toBe(
		'2026-07-29T12:00:40.000Z',
	)
})
