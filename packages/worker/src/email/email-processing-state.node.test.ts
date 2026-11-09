import { expect, test } from 'vitest'
import { emailProcessingState } from './email-processing-state.ts'

test('email_messages.processing_status preserves the accepted lifecycle graph', () => {
	expect(emailProcessingState.initial).toEqual(['stored', 'sent', 'failed'])
	expect(emailProcessingState.transitions).toEqual({
		stored: ['stored', 'sent', 'failed'],
		sent: ['stored', 'sent', 'failed'],
		failed: ['stored', 'sent', 'failed'],
	})
	expect(emailProcessingState.terminal).toEqual([])
})
