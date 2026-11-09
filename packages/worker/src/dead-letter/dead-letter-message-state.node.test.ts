import { expect, test } from 'vitest'
import { deadLetterMessageState } from './dead-letter-message-state.ts'

test('dead_letter_messages.status preserves the lifecycle graph', () => {
	expect(deadLetterMessageState.initial).toEqual(['parked'])
	expect(deadLetterMessageState.transitions).toEqual({
		parked: ['parked', 'replaying'],
		replaying: ['parked', 'replaying'],
	})
	expect(deadLetterMessageState.terminal).toEqual([])
})
