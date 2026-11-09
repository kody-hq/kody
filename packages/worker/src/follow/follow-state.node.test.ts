import { expect, test } from 'vitest'
import { followState } from './follow-state.ts'

test('follows pause on access failure and resume after reauthorization', () => {
	expect(followState.can('active', 'paused')).toBe(true)
	expect(followState.can('paused', 'active')).toBe(true)
	expect(followState.can('active', 'active')).toBe(false)
	expect(followState.isTerminal('paused')).toBe(false)
})
