import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const accountDeletionApprovalState = setup({
	types: {
		events: {} as
			| { type: 'CONSUME' }
			| { type: 'ROLLBACK' }
			| { type: 'EXPIRE' },
	},
}).createMachine({
	id: 'admin_account_deletion_approvals.lifecycle',
	description:
		'Approvals expire or are consumed for deletion, with consumption rolled back on failure and expiry assessed on the next read.',
	initial: 'pending',
	states: {
		pending: { on: { CONSUME: 'consumed', EXPIRE: 'expired' } },
		consumed: { on: { ROLLBACK: 'pending' } },
		expired: { type: 'final' },
	},
})

export type AccountDeletionApprovalStatus = LifecycleStateOf<
	typeof accountDeletionApprovalState
>
