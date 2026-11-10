import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const platformFeedbackState = setup({
	schemas: {
		events: {
			REVIEW_OPEN: types<{}>(),
			TRIAGE: types<{}>(),
			RESOLVE: types<{}>(),
			DISMISS: types<{}>(),
		},
	},
}).createMachine({
	id: 'platform_feedback.status',
	description:
		'Feedback triages or closes, closed feedback reopens to triaged, and review edits may preserve status.',
	initial: 'open',
	states: {
		open: {
			on: {
				REVIEW_OPEN: { target: 'open' },
				TRIAGE: { target: 'triaged' },
				RESOLVE: { target: 'resolved' },
				DISMISS: { target: 'dismissed' },
			},
		},
		triaged: {
			on: {
				TRIAGE: { target: 'triaged' },
				RESOLVE: { target: 'resolved' },
				DISMISS: { target: 'dismissed' },
			},
		},
		resolved: {
			on: { RESOLVE: { target: 'resolved' }, TRIAGE: { target: 'triaged' } },
		},
		dismissed: {
			on: { DISMISS: { target: 'dismissed' }, TRIAGE: { target: 'triaged' } },
		},
	},
})

export type PlatformFeedbackStatus = LifecycleStateOf<
	typeof platformFeedbackState
>
