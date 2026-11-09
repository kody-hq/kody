import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const inboundDeliveryState = defineStateMachine({
	name: 'email_inbound_delivery.state',
	description:
		'Inbound deliveries acquire storage or cleanup leases, release or reclaim them, finalize receipt, or reject; missing stored messages permit refinalization.',
	initial: 'pending',
	transitions: {
		pending: ['storing', 'cleaning', 'rejected'],
		storing: ['storing', 'pending', 'received', 'cleaning', 'rejected'],
		cleaning: ['cleaning', 'pending', 'orphan-cleaned', 'rejected'],
		received: ['storing'],
		rejected: [],
		'orphan-cleaned': ['cleaning', 'rejected'],
	},
})
export type InboundDeliveryState = StateOf<typeof inboundDeliveryState>
