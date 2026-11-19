import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const newsletterSignupState = setup({
	schemas: {
		events: {
			CONFIRM: types<{}>(),
			UNSUBSCRIBE: types<{}>(),
			RESUBSCRIBE: types<{}>(),
		},
	},
}).createMachine({
	id: 'newsletter_signups.status',
	description:
		'A public newsletter sign-up joins the list only after its emailed link is confirmed, and can leave and rejoin afterwards.',
	initial: 'pending',
	states: {
		pending: { on: { CONFIRM: { target: 'confirmed' } } },
		confirmed: { on: { UNSUBSCRIBE: { target: 'unsubscribed' } } },
		unsubscribed: {
			on: {
				CONFIRM: { target: 'confirmed' },
				RESUBSCRIBE: { target: 'confirmed' },
			},
		},
	},
})

export type NewsletterSignupStatus = LifecycleStateOf<
	typeof newsletterSignupState
>
