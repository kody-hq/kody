import { expect, test } from 'vitest'
import { enablementState } from './enablement-state.ts'

test('enablements.state preserves the accepted lifecycle graph', () => {
	expect(enablementState.initial).toEqual(['on'])
	expect(enablementState.transitions).toEqual({
		on: ['paused', 'off'],
		paused: ['paused', 'on', 'off'],
		off: [],
	})
	expect(enablementState.terminal).toEqual(['off'])
})
