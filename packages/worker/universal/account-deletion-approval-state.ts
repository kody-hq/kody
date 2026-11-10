import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const accountDeletionApprovalState = setup({
	schemas: {
		events: {
			CONSUME: types<{}>(),
			ROLLBACK: types<{}>(),
			EXPIRE: types<{}>(),
		},
	},
}).createMachine({
	id: 'admin_account_deletion_approvals.lifecycle',
	description:
		'Approvals expire or are consumed for deletion, with consumption rolled back on failure and expiry assessed on the next read.',
	initial: 'pending',
	states: {
		pending: {
			on: { CONSUME: { target: 'consumed' }, EXPIRE: { target: 'expired' } },
		},
		consumed: { on: { ROLLBACK: { target: 'pending' } } },
		expired: { type: 'final' },
	},
})

export type AccountDeletionApprovalStatus = LifecycleStateOf<
	typeof accountDeletionApprovalState
>
