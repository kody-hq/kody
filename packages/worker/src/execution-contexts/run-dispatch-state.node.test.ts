import {
	nextState,
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { runDispatchState } from './run-dispatch-state.ts'

test('dispatch cannot stay dispatched; committed runs finish once; rejected and aborted retry', () => {
	expect(() =>
		nextState(runDispatchState, 'dispatched', { type: 'OFFER' }),
	).toThrow('Illegal')
	expect(canHandle(runDispatchState, 'dispatched', 'COMMIT')).toBe(true)
	expect(canHandle(runDispatchState, 'rejected', 'OFFER')).toBe(true)
	expect(canHandle(runDispatchState, 'aborted', 'OFFER')).toBe(true)
	expect(canHandle(runDispatchState, 'committed', 'SUCCEED')).toBe(true)
	expect(canHandle(runDispatchState, 'committed', 'ABORT')).toBe(true)
	expect(canHandle(runDispatchState, 'committed', 'REJECT')).toBe(true)
	expect(finalStatesOf(runDispatchState).includes('succeeded')).toBe(true)
	expect(finalStatesOf(runDispatchState).includes('failed')).toBe(true)
	expect(finalStatesOf(runDispatchState).includes('cancelled')).toBe(true)
	expect(finalStatesOf(runDispatchState).includes('lost')).toBe(true)
	expect(finalStatesOf(runDispatchState).includes('aborted')).toBe(false)
	expect(finalStatesOf(runDispatchState).includes('rejected')).toBe(false)
})
