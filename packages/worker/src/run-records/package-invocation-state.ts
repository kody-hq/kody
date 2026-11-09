import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const packageInvocationState = defineStateMachine({
	name: 'package_invocation_ledger.status',
	description:
		'Invocation claims heartbeat or reclaim an in-progress attempt and atomically persist its completed or failed response.',
	initial: 'in_progress',
	transitions: {
		in_progress: ['in_progress', 'completed', 'failed'],
		completed: [],
		failed: [],
	},
})
export type PackageInvocationLedgerStatus = StateOf<
	typeof packageInvocationState
>
