import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { platformFeedbackState } from './platform-feedback-state.ts'

test('feedback closes from open or triaged and reopens only to triaged', () => {
	expect(canHandle(platformFeedbackState, 'open', 'TRIAGE')).toBe(true)
	expect(canHandle(platformFeedbackState, 'open', 'RESOLVE')).toBe(true)
	expect(canHandle(platformFeedbackState, 'triaged', 'RESOLVE')).toBe(true)
	expect(canHandle(platformFeedbackState, 'resolved', 'TRIAGE')).toBe(true)
	expect(canHandle(platformFeedbackState, 'dismissed', 'TRIAGE')).toBe(true)
	expect(canHandle(platformFeedbackState, 'resolved', 'REVIEW_OPEN')).toBe(
		false,
	)
	expect(canHandle(platformFeedbackState, 'dismissed', 'REVIEW_OPEN')).toBe(
		false,
	)
	expect(canHandle(platformFeedbackState, 'open', 'REVIEW_OPEN')).toBe(true)
	expect(canHandle(platformFeedbackState, 'resolved', 'RESOLVE')).toBe(true)
})
