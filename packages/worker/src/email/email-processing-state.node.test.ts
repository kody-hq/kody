import { expect, test } from 'vitest'
import { emailProcessingState } from './email-processing-state.ts'

test('email_messages.processing_status accepts every replacement including inserts', () => {
	const statuses = ['stored', 'sent', 'failed'] as const
	expect(emailProcessingState.values).toEqual([...statuses])
	for (const value of statuses)
		expect(emailProcessingState.parse(value)).toBe(value)
	expect(emailProcessingState.sql(statuses)).toBe(
		"('stored', 'sent', 'failed')",
	)
	expect(emailProcessingState.is('queued')).toBe(false)
	expect(() => emailProcessingState.parse('queued')).toThrow(
		'email_messages.processing_status',
	)
})
