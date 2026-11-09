import { expect, test } from 'vitest'
import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'

test('subscription effects reclaim processing, dead-letter, and reset completed rows to pending', () => {
	expect(inboundSubscriptionEffectState.can('pending', 'processing')).toBe(true)
	expect(inboundSubscriptionEffectState.can('processing', 'pending')).toBe(true)
	expect(inboundSubscriptionEffectState.can('processing', 'complete')).toBe(
		true,
	)
	expect(inboundSubscriptionEffectState.can('processing', 'dead-letter')).toBe(
		true,
	)
	expect(inboundSubscriptionEffectState.can('complete', 'pending')).toBe(true)
	expect(inboundSubscriptionEffectState.can('dead-letter', 'pending')).toBe(
		true,
	)
	expect(inboundSubscriptionEffectState.isTerminal('complete')).toBe(false)
	expect(inboundSubscriptionEffectState.isTerminal('dead-letter')).toBe(false)
})
