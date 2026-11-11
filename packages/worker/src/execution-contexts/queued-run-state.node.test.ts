import {
	canHandle,
	finalStatesOf,
	nextState,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { queuedRunState } from './queued-run-state.ts'

test('queued handoff fences cancel until it releases, then retry or leave', () => {
	expect(nextState(queuedRunState, 'queued', { type: 'START_HANDOFF' })).toBe(
		'starting',
	)
	expect(canHandle(queuedRunState, 'queued', 'CANCEL')).toBe(true)
	expect(canHandle(queuedRunState, 'starting', 'CANCEL')).toBe(false)
	expect(
		nextState(queuedRunState, 'starting', { type: 'RELEASE_HANDOFF' }),
	).toBe('queued')
	expect(() =>
		nextState(queuedRunState, 'queued', { type: 'RELEASE_HANDOFF' }),
	).toThrow('Illegal')
	expect(canHandle(queuedRunState, 'starting', 'FINISH')).toBe(true)
	expect(canHandle(queuedRunState, 'starting', 'EXPIRE')).toBe(true)
	expect(finalStatesOf(queuedRunState).includes('starting')).toBe(false)
	expect(finalStatesOf(queuedRunState).includes('finished')).toBe(true)
	expect(finalStatesOf(queuedRunState).includes('cancelled')).toBe(true)
	expect(finalStatesOf(queuedRunState).includes('expired')).toBe(true)
})
