import { expect, test } from 'vitest'
import { createManualClock } from '#worker/test-support/manual-clock.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { sleep } from './clock.ts'
import { startPassBudget } from './budget.ts'
import { runClaimed } from './claim.ts'
import { d1All, d1Run } from './d1.ts'
import {
	RetentionError,
	reportableCause,
	toRetentionFailure,
} from './failures.ts'
import { retry, type RetryPolicy } from './retry.ts'
import { withTimeout } from './timeout.ts'
import { z } from 'zod'
import { scheduledOutcomeForRetentionFailure } from './tick.ts'

const lockError = () => new Error('D1_ERROR: database is locked')

const policy: RetryPolicy = {
	maxAttempts: 4,
	baseDelayMs: 100,
	jitter: () => 'none',
	isRetryable: (error) => error instanceof Error && error.message === 'retry',
}

test('retry backs off exponentially on the injected clock and returns the value', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	const attemptsAt: Array<number> = []
	const run = retry({
		policy,
		clock,
		attempt: async (attempt) => {
			attemptsAt.push(clock.nowMs())
			if (attempt < 3) throw new Error('retry')
			return 'done'
		},
	})
	await clock.advance(1_000)
	expect(await run).toEqual({ ok: true, value: 'done', attempts: 3 })
	const start = new Date('2026-01-01T00:00:00Z').getTime()
	expect(attemptsAt.map((at) => at - start)).toEqual([0, 100, 300])
})

test('retry stops on a non-retryable error and on exhaustion', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	const fatal = new Error('fatal')
	expect(
		await retry({
			policy,
			clock,
			attempt: async () => {
				throw fatal
			},
		}),
	).toEqual({ ok: false, error: fatal, attempts: 1, retryable: false })

	let calls = 0
	const exhausted = retry({
		policy,
		clock,
		attempt: async () => {
			calls += 1
			throw new Error('retry')
		},
	})
	await clock.advance(10_000)
	expect(await exhausted).toMatchObject({
		ok: false,
		attempts: 4,
		retryable: true,
	})
	expect(calls).toBe(4)
})

test('retry half jitter stays inside [backoff/2, backoff)', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	const attemptsAt: Array<number> = []
	const run = retry({
		policy: { ...policy, maxAttempts: 2, jitter: () => 'half' },
		clock,
		random: () => 0.5,
		attempt: async (attempt) => {
			attemptsAt.push(clock.nowMs())
			if (attempt === 1) throw new Error('retry')
			return attempt
		},
	})
	await clock.advance(1_000)
	await run
	expect(attemptsAt[1]! - attemptsAt[0]!).toBe(75)
})

test('retry gives up when the signal aborts during backoff', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	const controller = new AbortController()
	let calls = 0
	const run = retry({
		policy,
		clock,
		signal: controller.signal,
		attempt: async () => {
			calls += 1
			throw new Error('retry')
		},
	})
	await clock.advance(10)
	controller.abort(new Error('stop'))
	expect(await run).toMatchObject({ ok: false, attempts: 1 })
	expect(calls).toBe(1)
})

test('withTimeout rejects with a typed timed_out failure and aborts the signal', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	let seen: AbortSignal | null = null
	const run = withTimeout({
		operation: 'kv.delete',
		timeoutMs: 500,
		clock,
		run: (signal) => {
			seen = signal
			return new Promise<never>(() => {})
		},
	})
	const settled = run.catch((error: unknown) => error)
	await clock.advance(499)
	expect(seen!.aborted).toBe(false)
	await clock.advance(1)
	const error = await settled
	expect(error).toBeInstanceOf(RetentionError)
	expect((error as RetentionError).failure).toEqual({
		kind: 'timed_out',
		operation: 'kv.delete',
		timeoutMs: 500,
	})
	expect(seen!.aborted).toBe(true)
	expect(clock.pendingTimers()).toBe(0)
})

test('withTimeout resolves, clears its timer, and honours a parent abort', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	expect(
		await withTimeout({
			operation: 'op',
			timeoutMs: 500,
			clock,
			run: async () => 7,
		}),
	).toBe(7)
	expect(clock.pendingTimers()).toBe(0)

	const controller = new AbortController()
	const run = withTimeout({
		operation: 'op',
		timeoutMs: 500,
		clock,
		signal: controller.signal,
		run: () => new Promise<never>(() => {}),
	}).catch((error: unknown) => error)
	controller.abort(new Error('shutdown'))
	expect(((await run) as RetentionError).failure.kind).toBe('aborted')
})

test('sleep resolves on the clock and rejects on abort', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	let done = false
	const pending = sleep(clock, 50).then(() => {
		done = true
	})
	await clock.advance(49)
	expect(done).toBe(false)
	await clock.advance(1)
	await pending
	expect(done).toBe(true)
	const controller = new AbortController()
	controller.abort(new Error('x'))
	await expect(sleep(clock, 5, controller.signal)).rejects.toThrow('x')
})

test('pass budget distinguishes reached (>=) from exceeded (>)', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	const budget = startPassBudget(clock, 100)
	expect([budget.reached(), budget.exceeded()]).toEqual([false, false])
	await clock.advance(100)
	expect([budget.reached(), budget.exceeded()]).toEqual([true, false])
	await clock.advance(1)
	expect([budget.reached(), budget.exceeded()]).toEqual([true, true])
	expect(startPassBudget(clock, 0).reached()).toBe(true)
	expect(startPassBudget(clock, 0).exceeded()).toBe(false)
})

test('runClaimed accounts for the claim on every exit path', async () => {
	const released: Array<string> = []
	const release = async (claim: string) => {
		released.push(claim)
	}
	expect(
		await runClaimed({
			acquire: async () => null,
			body: async () => 1,
			onFailure: () => 'release',
			release,
		}),
	).toEqual({ status: 'not_claimed' })
	expect(
		await runClaimed({
			acquire: async () => 'a',
			body: async () => 1,
			onFailure: () => 'release',
			release,
		}),
	).toEqual({ status: 'completed', value: 1, disposition: 'consumed' })
	const boom = new Error('boom')
	expect(
		await runClaimed({
			acquire: async () => 'b',
			body: async () => {
				throw boom
			},
			onFailure: () => 'keep',
			release,
		}),
	).toEqual({ status: 'failed', error: boom, disposition: 'kept' })
	expect(
		await runClaimed({
			acquire: async () => 'c',
			body: async () => {
				throw boom
			},
			onFailure: () => 'release',
			release,
		}),
	).toEqual({ status: 'failed', error: boom, disposition: 'released' })
	const releaseError = new Error('release down')
	expect(
		await runClaimed({
			acquire: async () => 'd',
			body: async () => {
				throw boom
			},
			onFailure: () => 'release',
			release: async () => {
				throw releaseError
			},
		}),
	).toEqual({
		status: 'failed',
		error: boom,
		disposition: 'release_failed',
		releaseError,
	})
	expect(released).toEqual(['c'])
})

function fakeDb(handlers: {
	all?: () => Promise<{ results: Array<unknown> }>
	run?: () => Promise<{ meta: unknown }>
}) {
	const statement = {
		bind: () => statement,
		all: handlers.all,
		run: handlers.run,
	}
	return { prepare: () => statement } as unknown as D1Database
}

test('d1All validates every row and maps bad rows to row_validation_failed', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	const db = fakeDb({
		all: async () => ({ results: [{ id: 'x' }, { id: 3 }] }),
	})
	const error = await d1All(
		{ db, clock },
		{ operation: 'list', sql: 'SELECT', row: z.object({ id: z.string() }) },
	).catch((e: unknown) => e)
	expect((error as RetentionError).failure).toEqual({
		kind: 'row_validation_failed',
		operation: 'list',
		issues: 'id: Invalid input: expected string, received number',
	})
})

test('d1Run retries lock errors with the D1 backoff and maps exhaustion to d1_lock_contention', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	let calls = 0
	const db = fakeDb({
		run: async () => {
			calls += 1
			if (calls < 3) throw lockError()
			return { meta: { changes: 2 } }
		},
	})
	const ok = d1Run({ db, clock }, { operation: 'delete', sql: 'DELETE' })
	await clock.advance(1_000)
	expect(await ok).toBe(2)
	expect(calls).toBe(3)

	const locked = fakeDb({
		run: async () => {
			throw lockError()
		},
	})
	const failing = d1Run(
		{ db: locked, clock },
		{ operation: 'delete', sql: 'DELETE' },
	).catch((e: unknown) => e)
	await clock.advance(60_000)
	const error = (await failing) as RetentionError
	expect(error.failure).toMatchObject({
		kind: 'd1_lock_contention',
		operation: 'delete',
		attempts: 6,
	})
	expect(error.message).toBe('D1_ERROR: database is locked')
})

test('d1Run does not retry a write that timed out (it may have landed)', async () => {
	const clock = createManualClock('2026-01-01T00:00:00Z')
	let calls = 0
	const db = fakeDb({
		run: () => {
			calls += 1
			return new Promise<never>(() => {})
		},
	})
	const failing = d1Run(
		{ db, clock },
		{ operation: 'claim', sql: 'UPDATE' },
	).catch((e: unknown) => e)
	await clock.advance(60_000)
	expect(((await failing) as RetentionError).failure.kind).toBe('timed_out')
	expect(calls).toBe(1)
})

test('toRetentionFailure keeps typed failures and classifies raw errors', () => {
	const typed = new RetentionError({
		kind: 'timed_out',
		operation: 'x',
		timeoutMs: 1,
	})
	expect(toRetentionFailure('op', typed)).toBe(typed.failure)
	expect(toRetentionFailure('op', lockError()).kind).toBe('d1_lock_contention')
	expect(toRetentionFailure('op', new Error('nope')).kind).toBe('unexpected')
})

test('scheduled outcome mapping: lock contention retries, everything else fails and reports the cause', () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const scheduledAt = new Date('2026-01-01T00:00:00Z')
	const cause = lockError()
	expect(
		scheduledOutcomeForRetentionFailure({
			lane: 'retention',
			scheduledAt,
			failure: {
				kind: 'd1_lock_contention',
				operation: 'x',
				attempts: 6,
				cause,
			},
		}),
	).toBe('d1_lock_contention')
	expect(consoleWarn).toHaveBeenCalledWith(
		'scheduled_lane_d1_lock_contention lane=retention',
		cause,
	)
	const unexpected = new Error('boom')
	expect(
		scheduledOutcomeForRetentionFailure({
			lane: 'soft_delete_purge',
			scheduledAt,
			failure: { kind: 'unexpected', operation: 'x', cause: unexpected },
		}),
	).toBe('failed')
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_failed lane=soft_delete_purge',
		unexpected,
	)
	expect(
		reportableCause({ kind: 'timed_out', operation: 'kv', timeoutMs: 5 }),
	).toBeInstanceOf(RetentionError)
})
