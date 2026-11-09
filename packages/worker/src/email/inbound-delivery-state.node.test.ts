import { expect, test } from 'vitest'
import { inboundDeliveryState } from './inbound-delivery-state.ts'

test('inbound delivery leases reclaim, finalize, reject, and refinalize missing stored messages', () => {
	expect(inboundDeliveryState.can('pending', 'storing')).toBe(true)
	expect(inboundDeliveryState.can('pending', 'cleaning')).toBe(true)
	expect(inboundDeliveryState.can('pending', 'received')).toBe(false)
	expect(inboundDeliveryState.can('storing', 'received')).toBe(true)
	expect(inboundDeliveryState.can('storing', 'pending')).toBe(true)
	expect(inboundDeliveryState.can('received', 'storing')).toBe(true)
	expect(inboundDeliveryState.can('received', 'pending')).toBe(false)
	expect(inboundDeliveryState.can('cleaning', 'orphan-cleaned')).toBe(true)
	expect(inboundDeliveryState.can('orphan-cleaned', 'cleaning')).toBe(true)
	expect(inboundDeliveryState.isTerminal('rejected')).toBe(true)
	expect(() => inboundDeliveryState.assert('rejected', 'pending')).toThrow(
		'Illegal',
	)
})
