import {
	finalStatesOf,
	nextState,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { queuedRunState } from './queued-run-state.ts'

test('execution_context_queued.lifecycle pins transitions and terminal fencing', () => {
	expect([queuedRunState.config.initial]).toEqual(['queued'])
	expect(queuedRunState.config.states).toEqual({
		queued: {
			on: {
				START_HANDOFF: { target: 'starting' },
				FINISH: { target: 'finished' },
				CANCEL: { target: 'cancelled' },
				EXPIRE: { target: 'expired' },
			},
		},
		starting: {
			on: {
				RELEASE_HANDOFF: { target: 'queued' },
				FINISH: { target: 'finished' },
				EXPIRE: { target: 'expired' },
			},
		},
		finished: { type: 'final' },
		cancelled: { type: 'final' },
		expired: { type: 'final' },
	})
	expect(finalStatesOf(queuedRunState)).toEqual([
		'finished',
		'cancelled',
		'expired',
	])
	expect(() =>
		nextState(queuedRunState, 'queued', { type: 'RELEASE_HANDOFF' }),
	).toThrow('Illegal')
})
