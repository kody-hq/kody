import { finalStatesOf } from '@kody-internal/shared/state-machine.ts'
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { scheduledLaneRunState } from './scheduled-lane-run-state.ts'

const lockError = new Error('D1_ERROR: Network connection lost.')

function runLane(
	steps: {
		acquire?: () => Promise<boolean>
		lane?: () => Promise<void>
		report?: () => Promise<void>
		release?: () => Promise<void>
	},
	leased = true,
) {
	const calls: Array<string> = []
	function step<T>(name: string, body: () => Promise<T>) {
		return createAsyncLogic({
			run: async () => {
				calls.push(name)
				return body()
			},
		})
	}
	const machine = scheduledLaneRunState.provide({
		actors: {
			acquireLease: step('acquire', steps.acquire ?? (async () => true)),
			runLane: step('run', steps.lane ?? (async () => {})),
			reportFailure: step('report', steps.report ?? (async () => {})),
			releaseLease: step('release', steps.release ?? (async () => {})),
		},
	})
	const output = toPromise(
		createActor(machine, {
			input: {
				lane: 'retention',
				scheduledTime: '2026-11-22T15:00:00.000Z',
				lease: leased ? { holder: 'holder', leaseMs: 60_000 } : null,
			},
		}).start(),
	)
	return { calls, output }
}

test('every settled lane run is a final state, and only settled runs are final', () => {
	expect([...finalStatesOf(scheduledLaneRunState)].sort()).toEqual(
		[
			'completed',
			'failed',
			'lock_contention',
			'report_failed',
			'skipped_overlap',
		].sort(),
	)
})

test('a failing leased lane reports the failure before it releases the lease', async () => {
	const { calls, output } = runLane({
		lane: async () => {
			throw new Error('boom')
		},
	})
	expect(await output).toEqual({ status: 'failed' })
	expect(calls).toEqual(['acquire', 'run', 'report', 'release'])
})

test('a failed failure report still releases the lease and surfaces the report error', async () => {
	const reportError = new Error('sentry down')
	const { calls, output } = runLane({
		lane: async () => {
			throw new Error('boom')
		},
		report: async () => {
			throw reportError
		},
	})
	expect(await output).toEqual({ status: 'report_failed', error: reportError })
	expect(calls).toEqual(['acquire', 'run', 'report', 'release'])
})

test('an overlapping run neither runs the lane nor releases a lease it never held', async () => {
	consoleWarn.mockImplementation(() => {})
	const { calls, output } = runLane({ acquire: async () => false })
	expect(await output).toEqual({ status: 'completed' })
	expect(calls).toEqual(['acquire'])
	expect(consoleWarn).toHaveBeenCalledWith(
		'scheduled_lane_skipped_overlap',
		expect.objectContaining({ lane: 'retention' }),
	)
})

test('D1 lock contention is not reported and releases only a held lease', async () => {
	expect(isRetryableD1LockError(lockError)).toBe(true)
	consoleWarn.mockImplementation(() => {})
	const running = runLane({
		lane: async () => {
			throw lockError
		},
	})
	expect(await running.output).toEqual({ status: 'd1_lock_contention' })
	expect(running.calls).toEqual(['acquire', 'run', 'release'])
	const acquiring = runLane({
		acquire: async () => {
			throw lockError
		},
	})
	expect(await acquiring.output).toEqual({ status: 'd1_lock_contention' })
	expect(acquiring.calls).toEqual(['acquire'])
})

test('a failed lease release keeps the lane result, and unleased lanes skip the lease', async () => {
	consoleWarn.mockImplementation(() => {})
	const releasing = runLane({
		release: async () => {
			throw new Error('release failed')
		},
	})
	expect(await releasing.output).toEqual({ status: 'completed' })
	expect(releasing.calls).toEqual(['acquire', 'run', 'release'])
	const unleased = runLane({}, false)
	expect(await unleased.output).toEqual({ status: 'completed' })
	expect(unleased.calls).toEqual(['run'])
})
