import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { followState } from './follow-state.ts'

test('follows pause on access failure and resume after reauthorization', () => {
	expect(canHandle(followState, 'active', 'PAUSE')).toBe(true)
	expect(canHandle(followState, 'paused', 'REAUTHORIZE')).toBe(true)
	expect(canHandle(followState, 'active', 'REAUTHORIZE')).toBe(false)
	expect(finalStatesOf(followState).includes('paused')).toBe(false)
})
