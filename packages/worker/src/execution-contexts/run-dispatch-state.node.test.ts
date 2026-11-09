import { expect, test } from 'vitest'
import { runDispatchState } from './run-dispatch-state.ts'

test('execution_context_runs.state pins transitions and terminal fencing', () => {
	expect(runDispatchState.initial).toEqual(['dispatched'])
	expect(runDispatchState.transitions).toEqual({
		dispatched: ['committed', 'aborted', 'rejected'],
		committed: [
			'succeeded',
			'failed',
			'cancelled',
			'lost',
			'aborted',
			'rejected',
		],
		succeeded: [],
		failed: [],
		cancelled: [],
		lost: [],
		rejected: ['dispatched', 'rejected', 'aborted'],
		aborted: ['dispatched', 'rejected', 'aborted'],
	})
	expect(runDispatchState.terminal).toEqual([
		'succeeded',
		'failed',
		'cancelled',
		'lost',
	])
	expect(() => runDispatchState.assert('dispatched', 'dispatched')).toThrow(
		'Illegal',
	)
})
