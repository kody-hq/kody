import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inboundSubscriptionEffectState = setup({
	types: {
		events: {} as
			| { type: 'RESET' }
			| { type: 'CLAIM' }
			| { type: 'COMPLETE' }
			| { type: 'DEAD_LETTER' },
	},
}).createMachine({
	id: 'email_inbound_subscription_effect.state',
	description:
		'Subscription delivery claims or reclaims processing, completes or retries to dead-letter, and refinalization resets the effect to pending.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				RESET: 'pending',
				CLAIM: 'processing',
				COMPLETE: 'complete',
				DEAD_LETTER: 'dead-letter',
			},
		},
		processing: {
			on: {
				CLAIM: 'processing',
				RESET: 'pending',
				COMPLETE: 'complete',
				DEAD_LETTER: 'dead-letter',
			},
		},
		complete: {
			on: {
				RESET: 'pending',
				COMPLETE: 'complete',
				DEAD_LETTER: 'dead-letter',
			},
		},
		'dead-letter': {
			on: {
				RESET: 'pending',
				COMPLETE: 'complete',
				DEAD_LETTER: 'dead-letter',
			},
		},
	},
})
export type InboundSubscriptionEffectState = LifecycleStateOf<
	typeof inboundSubscriptionEffectState
>
