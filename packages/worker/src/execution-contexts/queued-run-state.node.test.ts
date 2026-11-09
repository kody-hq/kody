import { expect, test } from 'vitest'
import { queuedRunState } from './queued-run-state.ts'

test('execution_context_queued.lifecycle pins transitions and terminal fencing', () => {
	expect(queuedRunState.initial).toEqual(['queued'])
	expect(queuedRunState.transitions).toEqual({
		queued: ['starting', 'finished', 'cancelled', 'expired'],
		starting: ['queued', 'finished', 'expired'],
		finished: [],
		cancelled: [],
		expired: [],
	})
	expect(queuedRunState.terminal).toEqual(['finished', 'cancelled', 'expired'])
	expect(() => queuedRunState.assert('queued', 'queued')).toThrow('Illegal')
})
