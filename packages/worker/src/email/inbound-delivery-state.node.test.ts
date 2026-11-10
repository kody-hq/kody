import {
	canHandle,
	finalStatesOf,
	nextState,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { inboundDeliveryState } from './inbound-delivery-state.ts'

test('inbound delivery leases reclaim, finalize, reject, and refinalize missing stored messages', () => {
	expect(canHandle(inboundDeliveryState, 'pending', 'CLAIM_STORAGE')).toBe(true)
	expect(canHandle(inboundDeliveryState, 'pending', 'CLAIM_CLEANUP')).toBe(true)
	expect(canHandle(inboundDeliveryState, 'pending', 'RECEIVE')).toBe(false)
	expect(canHandle(inboundDeliveryState, 'storing', 'RECEIVE')).toBe(true)
	expect(canHandle(inboundDeliveryState, 'storing', 'RELEASE_LEASE')).toBe(true)
	expect(canHandle(inboundDeliveryState, 'received', 'CLAIM_STORAGE')).toBe(
		true,
	)
	expect(canHandle(inboundDeliveryState, 'received', 'RELEASE_LEASE')).toBe(
		false,
	)
	expect(canHandle(inboundDeliveryState, 'cleaning', 'COMPLETE_CLEANUP')).toBe(
		true,
	)
	expect(
		canHandle(inboundDeliveryState, 'orphan-cleaned', 'CLAIM_CLEANUP'),
	).toBe(true)
	expect(finalStatesOf(inboundDeliveryState).includes('rejected')).toBe(true)
	expect(() =>
		nextState(inboundDeliveryState, 'rejected', { type: 'RELEASE_LEASE' }),
	).toThrow('Illegal')
})
