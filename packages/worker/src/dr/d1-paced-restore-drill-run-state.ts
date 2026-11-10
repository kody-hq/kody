import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const d1PacedRestoreDrillRunState = setup({
	schemas: { events: { PASS: types<{}>(), FAIL: types<{}>() } },
}).createMachine({
	id: 'dr_paced_restore_drill_runs.status',
	description:
		'A leased restore drill remains running until its sources finish and the aggregate passes or fails.',
	initial: 'running',
	states: {
		running: { on: { PASS: { target: 'passed' }, FAIL: { target: 'failed' } } },
		passed: { type: 'final' },
		failed: { type: 'final' },
	},
})

export type D1PacedRestoreDrillRunStatus = LifecycleStateOf<
	typeof d1PacedRestoreDrillRunState
>
