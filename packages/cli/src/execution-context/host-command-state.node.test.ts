import { expect, test } from 'vitest'
import { hostCommandState } from './host-command-state.ts'

test('host_background_command.state preserves the accepted lifecycle graph', () => {
	expect(hostCommandState.initial).toEqual(['running'])
	expect(hostCommandState.transitions).toEqual({
		running: ['timed_out', 'failed', 'exited', 'killed'],
		exited: [],
		killed: ['failed'],
		timed_out: ['failed'],
		failed: [],
	})
	expect(hostCommandState.terminal).toEqual(['exited', 'failed'])
})
