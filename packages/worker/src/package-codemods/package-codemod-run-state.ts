import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageCodemodRunState = setup({
	types: {
		events: {} as
			| { type: 'CONTINUE' }
			| { type: 'COMPLETE' }
			| { type: 'FAIL' }
			| { type: 'ABANDON' },
	},
}).createMachine({
	id: 'package_codemod_runs.status',
	description:
		'Codemod runs heartbeat, finish, fail or abandon; failed and abandoned runs resume, while a repeated completed continuation may complete again or fail.',
	initial: 'running',
	states: {
		running: {
			on: {
				CONTINUE: 'running',
				COMPLETE: 'completed',
				FAIL: 'failed',
				ABANDON: 'abandoned',
			},
		},
		completed: { on: { COMPLETE: 'completed', FAIL: 'failed' } },
		failed: { on: { CONTINUE: 'running' } },
		abandoned: { on: { CONTINUE: 'running' } },
	},
})

export type PackageCodemodRunStatus = LifecycleStateOf<
	typeof packageCodemodRunState
>
