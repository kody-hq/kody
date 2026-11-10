import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inboundDeliveryState = setup({
	schemas: {
		events: {
			CLAIM_STORAGE: types<{}>(),
			CLAIM_CLEANUP: types<{}>(),
			REJECT: types<{}>(),
			RELEASE_LEASE: types<{}>(),
			RECEIVE: types<{}>(),
			COMPLETE_CLEANUP: types<{}>(),
		},
	},
}).createMachine({
	id: 'email_inbound_delivery.state',
	description:
		'Inbound deliveries acquire storage or cleanup leases, release or reclaim them, finalize receipt, or reject; missing stored messages permit refinalization.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				CLAIM_STORAGE: { target: 'storing' },
				CLAIM_CLEANUP: { target: 'cleaning' },
				REJECT: { target: 'rejected' },
			},
		},
		storing: {
			on: {
				CLAIM_STORAGE: { target: 'storing' },
				RELEASE_LEASE: { target: 'pending' },
				RECEIVE: { target: 'received' },
				CLAIM_CLEANUP: { target: 'cleaning' },
				REJECT: { target: 'rejected' },
			},
		},
		cleaning: {
			on: {
				CLAIM_CLEANUP: { target: 'cleaning' },
				RELEASE_LEASE: { target: 'pending' },
				COMPLETE_CLEANUP: { target: 'orphan-cleaned' },
				REJECT: { target: 'rejected' },
			},
		},
		received: { on: { CLAIM_STORAGE: { target: 'storing' } } },
		rejected: { type: 'final' },
		'orphan-cleaned': {
			on: {
				CLAIM_CLEANUP: { target: 'cleaning' },
				REJECT: { target: 'rejected' },
			},
		},
	},
})
export type InboundDeliveryState = LifecycleStateOf<typeof inboundDeliveryState>
