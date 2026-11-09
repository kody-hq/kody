import { expect, test } from 'vitest'
import { platformFeedbackState } from './platform-feedback-state.ts'

test('platform_feedback.status preserves the lifecycle graph', () => {
	expect(platformFeedbackState.initial).toEqual(['open'])
	expect(platformFeedbackState.transitions).toEqual({
		open: ['open', 'triaged', 'resolved', 'dismissed'],
		triaged: ['triaged', 'resolved', 'dismissed'],
		resolved: ['resolved', 'triaged'],
		dismissed: ['dismissed', 'triaged'],
	})
	expect(platformFeedbackState.terminal).toEqual([])
})
