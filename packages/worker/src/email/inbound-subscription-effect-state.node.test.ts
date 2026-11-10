import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'

test('subscription effects reclaim processing, dead-letter, and reset completed rows to pending', () => {
	expect(canHandle(inboundSubscriptionEffectState, 'pending', 'CLAIM')).toBe(
		true,
	)
	expect(canHandle(inboundSubscriptionEffectState, 'processing', 'RESET')).toBe(
		true,
	)
	expect(
		canHandle(inboundSubscriptionEffectState, 'processing', 'COMPLETE'),
	).toBe(true)
	expect(
		canHandle(inboundSubscriptionEffectState, 'processing', 'DEAD_LETTER'),
	).toBe(true)
	expect(canHandle(inboundSubscriptionEffectState, 'complete', 'RESET')).toBe(
		true,
	)
	expect(
		canHandle(inboundSubscriptionEffectState, 'dead-letter', 'RESET'),
	).toBe(true)
	expect(
		finalStatesOf(inboundSubscriptionEffectState).includes('complete'),
	).toBe(false)
	expect(
		finalStatesOf(inboundSubscriptionEffectState).includes('dead-letter'),
	).toBe(false)
})
