import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageInvocationState = setup({
	schemas: {
		events: { CLAIM: types<{}>(), COMPLETE: types<{}>(), FAIL: types<{}>() },
	},
}).createMachine({
	id: 'package_invocation_ledger.status',
	description:
		'Invocation claims heartbeat or reclaim an in-progress attempt and atomically persist its completed or failed response.',
	initial: 'in_progress',
	states: {
		in_progress: {
			on: {
				CLAIM: { target: 'in_progress' },
				COMPLETE: { target: 'completed' },
				FAIL: { target: 'failed' },
			},
		},
		completed: { type: 'final' },
		failed: { type: 'final' },
	},
})
export type PackageInvocationLedgerStatus = LifecycleStateOf<
	typeof packageInvocationState
>
