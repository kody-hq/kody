import { expect, test } from 'vitest'
import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'

test('email_inbound_subscription_effect.state pins claim, reclaim and completion edges', () => {
	expect(inboundSubscriptionEffectState.initial).toEqual(['pending'])
	expect(inboundSubscriptionEffectState.transitions).toEqual({
		pending: ['pending', 'processing', 'complete', 'dead-letter'],
		processing: ['processing', 'pending', 'complete', 'dead-letter'],
		complete: ['pending', 'complete', 'dead-letter'],
		'dead-letter': ['pending', 'complete', 'dead-letter'],
	})
	expect(inboundSubscriptionEffectState.terminal).toEqual([])
})
