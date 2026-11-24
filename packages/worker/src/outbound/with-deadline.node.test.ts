import { expect, test } from 'vitest'
import { catchDeadline, deadlineFailure } from './typed-failure.ts'
import {
	type DeadlineClock,
	DeadlineExceededError,
	withDeadline,
} from '@kody-internal/shared/with-deadline.ts'

function manualClock() {
	const timers: Array<{ ms: number; onExpire: () => void; cleared: boolean }> =
		[]
	const clock: DeadlineClock = {
		setTimer: (ms, onExpire) => {
			const timer = { ms, onExpire, cleared: false }
			timers.push(timer)
			return () => {
				timer.cleared = true
			}
		},
	}
	return { clock, timers, expireAll: () => timers.forEach((t) => t.onExpire()) }
}

test('a call that settles in time resolves and clears its timer', async () => {
	const { clock, timers } = manualClock()
	await expect(
		withDeadline({ label: 'test.ok', timeoutMs: 50, clock }, async () => 7),
	).resolves.toBe(7)
	expect(timers).toEqual([expect.objectContaining({ ms: 50, cleared: true })])
})

test('an expired deadline aborts the signal and rejects with a typed failure', async () => {
	const { clock, expireAll } = manualClock()
	let signal: AbortSignal | undefined
	const pending = withDeadline(
		{ label: 'test.hang', timeoutMs: 10, clock },
		(callSignal) => {
			signal = callSignal
			return new Promise<never>(() => {})
		},
	)
	expireAll()
	const error = await pending.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(DeadlineExceededError)
	expect(signal?.aborted).toBe(true)
	expect(deadlineFailure(error)).toEqual({
		kind: 'deadline_exceeded',
		label: 'test.hang',
		timeoutMs: 10,
	})
})

test('catchDeadline returns the deadline failure and rethrows anything else', async () => {
	const { clock, expireAll } = manualClock()
	const pending = catchDeadline(() =>
		withDeadline(
			{ label: 'test.step', timeoutMs: 5, clock },
			() => new Promise<never>(() => {}),
		),
	)
	expireAll()
	await expect(pending).resolves.toMatchObject({ kind: 'deadline_exceeded' })
	await expect(
		catchDeadline(async () => {
			throw new Error('boom')
		}),
	).rejects.toThrow('boom')
})
