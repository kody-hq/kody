import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inboundSubscriptionEffectState = setup({
	schemas: {
		events: {
			RESET: types<{}>(),
			CLAIM: types<{}>(),
			COMPLETE: types<{}>(),
			DEAD_LETTER: types<{}>(),
		},
	},
}).createMachine({
	id: 'email_inbound_subscription_effect.state',
	description:
		'Subscription delivery claims or reclaims processing, completes or retries to dead-letter, and refinalization resets the effect to pending.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				RESET: { target: 'pending' },
				CLAIM: { target: 'processing' },
				COMPLETE: { target: 'complete' },
				DEAD_LETTER: { target: 'dead-letter' },
			},
		},
		processing: {
			on: {
				CLAIM: { target: 'processing' },
				RESET: { target: 'pending' },
				COMPLETE: { target: 'complete' },
				DEAD_LETTER: { target: 'dead-letter' },
			},
		},
		complete: {
			on: {
				RESET: { target: 'pending' },
				COMPLETE: { target: 'complete' },
				DEAD_LETTER: { target: 'dead-letter' },
			},
		},
		'dead-letter': {
			on: {
				RESET: { target: 'pending' },
				COMPLETE: { target: 'complete' },
				DEAD_LETTER: { target: 'dead-letter' },
			},
		},
	},
})
export type InboundSubscriptionEffectState = LifecycleStateOf<
	typeof inboundSubscriptionEffectState
>
