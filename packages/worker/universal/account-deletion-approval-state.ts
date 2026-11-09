import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const accountDeletionApprovalState = defineStateMachine({
	name: 'admin_account_deletion_approvals.lifecycle',
	description:
		'Approvals expire or are consumed for deletion, with consumption rolled back on failure and expiry assessed on the next read.',
	initial: 'pending',
	transitions: {
		pending: ['consumed', 'expired'],
		consumed: ['pending', 'expired'],
		expired: [],
	},
})

export type AccountDeletionApprovalStatus = StateOf<
	typeof accountDeletionApprovalState
>
