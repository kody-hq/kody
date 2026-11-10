import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageApprovalState = setup({
	schemas: { events: { APPROVE: types<{}>(), SUPERSEDE: types<{}>() } },
}).createMachine({
	id: 'package_approval_requests.status',
	description:
		'Pending package approvals resolve by owner approval or supersession by another publish.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				APPROVE: { target: 'approved' },
				SUPERSEDE: { target: 'superseded' },
			},
		},
		approved: { type: 'final' },
		superseded: { type: 'final' },
	},
})

export type PackageApprovalStatus = LifecycleStateOf<
	typeof packageApprovalState
>
