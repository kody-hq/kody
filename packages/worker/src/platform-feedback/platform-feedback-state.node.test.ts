import { expect, test } from 'vitest'
import { platformFeedbackState } from './platform-feedback-state.ts'

test('feedback closes from open or triaged and reopens only to triaged', () => {
	expect(platformFeedbackState.can('open', 'triaged')).toBe(true)
	expect(platformFeedbackState.can('open', 'resolved')).toBe(true)
	expect(platformFeedbackState.can('triaged', 'resolved')).toBe(true)
	expect(platformFeedbackState.can('resolved', 'triaged')).toBe(true)
	expect(platformFeedbackState.can('dismissed', 'triaged')).toBe(true)
	expect(platformFeedbackState.can('resolved', 'open')).toBe(false)
	expect(platformFeedbackState.can('dismissed', 'open')).toBe(false)
	expect(platformFeedbackState.can('open', 'open')).toBe(true)
	expect(platformFeedbackState.can('resolved', 'resolved')).toBe(true)
})
