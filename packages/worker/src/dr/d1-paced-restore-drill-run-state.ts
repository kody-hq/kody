import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const d1PacedRestoreDrillRunState = setup({
	types: {
		events: {} as { type: 'PASS' } | { type: 'FAIL' },
	},
}).createMachine({
	id: 'dr_paced_restore_drill_runs.status',
	description:
		'A leased restore drill remains running until its sources finish and the aggregate passes or fails.',
	initial: 'running',
	states: {
		running: { on: { PASS: 'passed', FAIL: 'failed' } },
		passed: { type: 'final' },
		failed: { type: 'final' },
	},
})

export type D1PacedRestoreDrillRunStatus = LifecycleStateOf<
	typeof d1PacedRestoreDrillRunState
>
