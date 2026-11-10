import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageApprovalState = setup({
	types: {
		events: {} as { type: 'APPROVE' } | { type: 'SUPERSEDE' },
	},
}).createMachine({
	id: 'package_approval_requests.status',
	description:
		'Pending package approvals resolve by owner approval or supersession by another publish.',
	initial: 'pending',
	states: {
		pending: { on: { APPROVE: 'approved', SUPERSEDE: 'superseded' } },
		approved: { type: 'final' },
		superseded: { type: 'final' },
	},
})

export type PackageApprovalStatus = LifecycleStateOf<
	typeof packageApprovalState
>
