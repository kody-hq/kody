import { expect, test } from 'vitest'
import { emailProcessingState } from './email-processing-state.ts'

test('email_messages.processing_status accepts every replacement including inserts', () => {
	expect([...emailProcessingState.values].sort()).toEqual(
		[...emailProcessingState.values].sort(),
	)
	expect(
		Reflect.ownKeys(emailProcessingState).filter(
			(key) => key === 'transitions' || key === 'terminal',
		),
	).toEqual([])
	for (const from of emailProcessingState.values) {
		for (const to of emailProcessingState.values) {
			expect(emailProcessingState.is(from) && emailProcessingState.is(to)).toBe(
				true,
			)
		}
	}
})
