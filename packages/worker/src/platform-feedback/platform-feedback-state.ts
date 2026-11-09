import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const platformFeedbackState = defineStateMachine({
	name: 'platform_feedback.status',
	description:
		'Feedback triages or closes, closed feedback reopens to triaged, and review edits may preserve status.',
	initial: 'open',
	transitions: {
		open: ['open', 'triaged', 'resolved', 'dismissed'],
		triaged: ['triaged', 'resolved', 'dismissed'],
		resolved: ['resolved', 'triaged'],
		dismissed: ['dismissed', 'triaged'],
	},
})

export type PlatformFeedbackStatus = StateOf<typeof platformFeedbackState>
