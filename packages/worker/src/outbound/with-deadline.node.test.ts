import { expect, test } from 'vitest'
import {
	type DeadlineClock,
	DeadlineExceededError,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'

function manualClock() {
	const timers: Array<{ ms: number; fire: () => void; cleared: boolean }> = []
	const clock: DeadlineClock = {
		setTimer: (ms, onExpire) => {
			const timer = { ms, fire: onExpire, cleared: false }
			timers.push(timer)
			return () => {
				timer.cleared = true
			}
		},
	}
	return { clock, timers }
}

test('withDeadline rejects with a labeled DeadlineExceededError and aborts the signal when the clock expires', async () => {
	const { clock, timers } = manualClock()
	let seenSignal: AbortSignal | undefined
	const pending = withDeadline(
		{ label: 'lane.read', timeoutMs: 250, clock },
		(signal) => {
			seenSignal = signal
			return new Promise<never>(() => {})
		},
	)
	expect(timers).toHaveLength(1)
	expect(timers[0]?.ms).toBe(250)
	timers[0]?.fire()
	const error = await pending.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(DeadlineExceededError)
	expect(error).toMatchObject({
		kind: 'deadline_exceeded',
		label: 'lane.read',
		timeoutMs: 250,
	})
	expect(seenSignal?.aborted).toBe(true)
	expect(seenSignal?.reason).toBe(error)
})

test('withDeadline resolves with the call result and clears its timer', async () => {
	const { clock, timers } = manualClock()
	await expect(
		withDeadline({ label: 'lane.read', timeoutMs: 250, clock }, async () => 7),
	).resolves.toBe(7)
	expect(timers[0]?.cleared).toBe(true)
})

test('withDeadline passes through the call failure and clears its timer', async () => {
	const { clock, timers } = manualClock()
	const failure = new Error('boom')
	await expect(
		withDeadline({ label: 'lane.read', timeoutMs: 250, clock }, async () => {
			throw failure
		}),
	).rejects.toBe(failure)
	expect(timers[0]?.cleared).toBe(true)
})

test('withDeadline rejects a non-positive deadline without starting the call', async () => {
	const { clock, timers } = manualClock()
	let called = false
	await expect(
		withDeadline({ label: 'lane.read', timeoutMs: 0, clock }, async () => {
			called = true
		}),
	).rejects.toBeInstanceOf(DeadlineExceededError)
	expect(called).toBe(false)
	expect(timers).toHaveLength(0)
})
