import {
	sqlSourcesOf,
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { deadLetterMessageState } from './dead-letter-message-state.ts'

test('dead_letter_messages.status claims, reclaims, and releases replay without a terminal', () => {
	expect(sqlSourcesOf(deadLetterMessageState, 'CLAIM_REPLAY', ['parked'])).toBe(
		"('parked')",
	)
	expect(canHandle(deadLetterMessageState, 'replaying', 'PARK')).toBe(true)
	expect(canHandle(deadLetterMessageState, 'replaying', 'CLAIM_REPLAY')).toBe(
		true,
	)
	expect(canHandle(deadLetterMessageState, 'parked', 'PARK')).toBe(true)
	expect(finalStatesOf(deadLetterMessageState)).toEqual([])
})
