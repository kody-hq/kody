import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const planTransferState = setup({
	schemas: {
		events: {
			CLAIM_LEASE: types<{}>(),
			CANCEL: types<{}>(),
			RELEASE_CHECKOUT: types<{}>(),
			RELEASE_RETRY: types<{}>(),
			COMPLETE: types<{}>(),
		},
	},
}).createMachine({
	id: 'org_plan_transfers.status',
	description:
		'Transfers begin at checkout or retry, acquire or reclaim an applying lease, and complete or cancel; applying can release back to checkout or retry. Rows or initial responses may enter directly in another listed state.',
	initial: 'pending_checkout',
	states: {
		pending_checkout: {
			on: {
				CLAIM_LEASE: { target: 'applying' },
				CANCEL: { target: 'canceled' },
			},
		},
		applying: {
			on: {
				CLAIM_LEASE: { target: 'applying' },
				RELEASE_CHECKOUT: { target: 'pending_checkout' },
				RELEASE_RETRY: { target: 'needs_retry' },
				COMPLETE: { target: 'completed' },
				CANCEL: { target: 'canceled' },
			},
		},
		needs_retry: {
			on: {
				CLAIM_LEASE: { target: 'applying' },
				CANCEL: { target: 'canceled' },
			},
		},
		completed: { type: 'final' },
		canceled: { type: 'final' },
	},
})

export type PlanTransferStatus = LifecycleStateOf<typeof planTransferState>
