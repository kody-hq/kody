import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageCodemodRunState = setup({
	schemas: {
		events: {
			CONTINUE: types<{}>(),
			COMPLETE: types<{}>(),
			FAIL: types<{}>(),
			ABANDON: types<{}>(),
		},
	},
}).createMachine({
	id: 'package_codemod_runs.status',
	description:
		'Codemod runs heartbeat, finish, fail or abandon; failed and abandoned runs resume, while a repeated completed continuation may complete again or fail.',
	initial: 'running',
	states: {
		running: {
			on: {
				CONTINUE: { target: 'running' },
				COMPLETE: { target: 'completed' },
				FAIL: { target: 'failed' },
				ABANDON: { target: 'abandoned' },
			},
		},
		completed: {
			on: { COMPLETE: { target: 'completed' }, FAIL: { target: 'failed' } },
		},
		failed: { on: { CONTINUE: { target: 'running' } } },
		abandoned: { on: { CONTINUE: { target: 'running' } } },
	},
})

export type PackageCodemodRunStatus = LifecycleStateOf<
	typeof packageCodemodRunState
>
