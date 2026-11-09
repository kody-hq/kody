import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const d1PacedRestoreDrillRunState = defineStateMachine({
	name: 'dr_paced_restore_drill_runs.status',
	description:
		'A leased restore drill remains running until its sources finish and the aggregate passes or fails.',
	initial: 'running',
	transitions: { running: ['passed', 'failed'], passed: [], failed: [] },
})

export type D1PacedRestoreDrillRunStatus = StateOf<
	typeof d1PacedRestoreDrillRunState
>
