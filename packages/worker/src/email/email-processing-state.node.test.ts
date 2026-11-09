import { expect, test } from 'vitest'
import { emailProcessingState } from './email-processing-state.ts'

test('email_messages.processing_status accepts every replacement including inserts', () => {
	expect([...emailProcessingState.initial].sort()).toEqual(
		[...emailProcessingState.states].sort(),
	)
	expect(emailProcessingState.terminal).toEqual([])
	for (const from of emailProcessingState.states) {
		for (const to of emailProcessingState.states) {
			expect(emailProcessingState.can(from, to)).toBe(true)
		}
	}
})
