import { expect, test } from 'vitest'
import { inboundDeliveryState } from './inbound-delivery-state.ts'

test('email_inbound_delivery.state pins claim, reclaim and completion edges', () => {
	expect(inboundDeliveryState.initial).toEqual(['pending'])
	expect(inboundDeliveryState.transitions).toEqual({
		pending: ['storing', 'cleaning', 'rejected'],
		storing: ['storing', 'pending', 'received', 'cleaning', 'rejected'],
		cleaning: ['cleaning', 'pending', 'orphan-cleaned', 'rejected'],
		received: ['storing'],
		rejected: [],
		'orphan-cleaned': ['cleaning', 'rejected'],
	})
	expect(inboundDeliveryState.terminal).toEqual(['rejected'])
})
