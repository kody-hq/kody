import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const planTransferState = defineStateMachine({
	name: 'org_plan_transfers.status',
	description:
		'Transfers begin at checkout or retry, acquire or reclaim an applying lease, and complete or cancel; applying can release back to checkout or retry.',
	initial: ['pending_checkout', 'needs_retry'],
	transitions: {
		pending_checkout: ['applying', 'canceled'],
		applying: [
			'applying',
			'pending_checkout',
			'needs_retry',
			'completed',
			'canceled',
		],
		needs_retry: ['applying', 'canceled'],
		completed: [],
		canceled: [],
	},
})

export type PlanTransferStatus = StateOf<typeof planTransferState>
