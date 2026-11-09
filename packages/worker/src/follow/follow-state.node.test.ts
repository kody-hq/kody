import { expect, test } from 'vitest'
import { followState } from './follow-state.ts'

test('follows.status preserves the lifecycle graph', () => {
	expect(followState.initial).toEqual(['active'])
	expect(followState.transitions).toEqual({
		active: ['paused'],
		paused: ['active'],
	})
	expect(followState.terminal).toEqual([])
})
