import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageInvocationState = setup({
	types: {
		events: {} as { type: 'CLAIM' } | { type: 'COMPLETE' } | { type: 'FAIL' },
	},
}).createMachine({
	id: 'package_invocation_ledger.status',
	description:
		'Invocation claims heartbeat or reclaim an in-progress attempt and atomically persist its completed or failed response.',
	initial: 'in_progress',
	states: {
		in_progress: {
			on: { CLAIM: 'in_progress', COMPLETE: 'completed', FAIL: 'failed' },
		},
		completed: { type: 'final' },
		failed: { type: 'final' },
	},
})
export type PackageInvocationLedgerStatus = LifecycleStateOf<
	typeof packageInvocationState
>
