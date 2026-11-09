import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const inboundSubscriptionEffectState = defineStateMachine({
	name: 'email_inbound_subscription_effect.state',
	description:
		'Subscription delivery claims or reclaims processing, completes or retries to dead-letter, and refinalization resets the effect to pending.',
	initial: 'pending',
	transitions: {
		pending: ['pending', 'processing', 'complete', 'dead-letter'],
		processing: ['processing', 'pending', 'complete', 'dead-letter'],
		complete: ['pending', 'complete', 'dead-letter'],
		'dead-letter': ['pending', 'complete', 'dead-letter'],
	},
})
export type InboundSubscriptionEffectState = StateOf<
	typeof inboundSubscriptionEffectState
>
