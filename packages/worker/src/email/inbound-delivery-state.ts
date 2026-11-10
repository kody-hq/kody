import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inboundDeliveryState = setup({
	types: {
		events: {} as
			| { type: 'CLAIM_STORAGE' }
			| { type: 'CLAIM_CLEANUP' }
			| { type: 'REJECT' }
			| { type: 'RELEASE_LEASE' }
			| { type: 'RECEIVE' }
			| { type: 'COMPLETE_CLEANUP' },
	},
}).createMachine({
	id: 'email_inbound_delivery.state',
	description:
		'Inbound deliveries acquire storage or cleanup leases, release or reclaim them, finalize receipt, or reject; missing stored messages permit refinalization.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				CLAIM_STORAGE: 'storing',
				CLAIM_CLEANUP: 'cleaning',
				REJECT: 'rejected',
			},
		},
		storing: {
			on: {
				CLAIM_STORAGE: 'storing',
				RELEASE_LEASE: 'pending',
				RECEIVE: 'received',
				CLAIM_CLEANUP: 'cleaning',
				REJECT: 'rejected',
			},
		},
		cleaning: {
			on: {
				CLAIM_CLEANUP: 'cleaning',
				RELEASE_LEASE: 'pending',
				COMPLETE_CLEANUP: 'orphan-cleaned',
				REJECT: 'rejected',
			},
		},
		received: { on: { CLAIM_STORAGE: 'storing' } },
		rejected: { type: 'final' },
		'orphan-cleaned': { on: { CLAIM_CLEANUP: 'cleaning', REJECT: 'rejected' } },
	},
})
export type InboundDeliveryState = LifecycleStateOf<typeof inboundDeliveryState>
