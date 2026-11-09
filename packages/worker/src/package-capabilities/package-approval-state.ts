import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const packageApprovalState = defineStateMachine({
	name: 'package_approval_requests.status',
	description:
		'Pending package approvals resolve by owner approval or supersession by another publish.',
	initial: 'pending',
	transitions: {
		pending: ['approved', 'superseded'],
		approved: [],
		superseded: [],
	},
})

export type PackageApprovalStatus = StateOf<typeof packageApprovalState>
