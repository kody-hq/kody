import { expect, test } from 'vitest'
import { runDispatchState } from './run-dispatch-state.ts'

test('dispatch cannot stay dispatched; committed runs finish once; rejected and aborted retry', () => {
	expect(() => runDispatchState.assert('dispatched', 'dispatched')).toThrow(
		'Illegal',
	)
	expect(runDispatchState.can('dispatched', 'committed')).toBe(true)
	expect(runDispatchState.can('rejected', 'dispatched')).toBe(true)
	expect(runDispatchState.can('aborted', 'dispatched')).toBe(true)
	expect(runDispatchState.can('committed', 'succeeded')).toBe(true)
	expect(runDispatchState.can('committed', 'aborted')).toBe(true)
	expect(runDispatchState.can('committed', 'rejected')).toBe(true)
	expect(runDispatchState.isTerminal('succeeded')).toBe(true)
	expect(runDispatchState.isTerminal('failed')).toBe(true)
	expect(runDispatchState.isTerminal('cancelled')).toBe(true)
	expect(runDispatchState.isTerminal('lost')).toBe(true)
	expect(runDispatchState.isTerminal('aborted')).toBe(false)
	expect(runDispatchState.isTerminal('rejected')).toBe(false)
})
