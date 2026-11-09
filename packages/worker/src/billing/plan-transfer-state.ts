import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const planTransferState = setup({
	types: {
		events: {} as
			| { type: 'CLAIM_LEASE' }
			| { type: 'CANCEL' }
			| { type: 'RELEASE_CHECKOUT' }
			| { type: 'RELEASE_RETRY' }
			| { type: 'COMPLETE' },
	},
}).createMachine({
	id: 'org_plan_transfers.status',
	description:
		'Transfers begin at checkout or retry, acquire or reclaim an applying lease, and complete or cancel; applying can release back to checkout or retry. Rows or initial responses may enter directly in another listed state.',
	initial: 'pending_checkout',
	states: {
		pending_checkout: { on: { CLAIM_LEASE: 'applying', CANCEL: 'canceled' } },
		applying: {
			on: {
				CLAIM_LEASE: 'applying',
				RELEASE_CHECKOUT: 'pending_checkout',
				RELEASE_RETRY: 'needs_retry',
				COMPLETE: 'completed',
				CANCEL: 'canceled',
			},
		},
		needs_retry: { on: { CLAIM_LEASE: 'applying', CANCEL: 'canceled' } },
		completed: { type: 'final' },
		canceled: { type: 'final' },
	},
})

export type PlanTransferStatus = LifecycleStateOf<typeof planTransferState>
