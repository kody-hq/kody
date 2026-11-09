import { expect, test } from 'vitest'
import { deadLetterMessageState } from './dead-letter-message-state.ts'

test('dead_letter_messages.status claims, reclaims, and releases replay without a terminal', () => {
	expect(
		deadLetterMessageState.guard({ from: 'parked', to: 'replaying' }),
	).toBe("('parked')")
	expect(deadLetterMessageState.can('replaying', 'parked')).toBe(true)
	expect(deadLetterMessageState.can('replaying', 'replaying')).toBe(true)
	expect(deadLetterMessageState.can('parked', 'parked')).toBe(true)
	expect(deadLetterMessageState.terminal).toEqual([])
})
