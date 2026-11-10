import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const platformFeedbackState = setup({
	types: {
		events: {} as
			| { type: 'REVIEW_OPEN' }
			| { type: 'TRIAGE' }
			| { type: 'RESOLVE' }
			| { type: 'DISMISS' },
	},
}).createMachine({
	id: 'platform_feedback.status',
	description:
		'Feedback triages or closes, closed feedback reopens to triaged, and review edits may preserve status.',
	initial: 'open',
	states: {
		open: {
			on: {
				REVIEW_OPEN: 'open',
				TRIAGE: 'triaged',
				RESOLVE: 'resolved',
				DISMISS: 'dismissed',
			},
		},
		triaged: {
			on: { TRIAGE: 'triaged', RESOLVE: 'resolved', DISMISS: 'dismissed' },
		},
		resolved: { on: { RESOLVE: 'resolved', TRIAGE: 'triaged' } },
		dismissed: { on: { DISMISS: 'dismissed', TRIAGE: 'triaged' } },
	},
})

export type PlatformFeedbackStatus = LifecycleStateOf<
	typeof platformFeedbackState
>
