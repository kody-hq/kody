import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const d1PacedRestoreDrillSourceState = defineStateMachine({
	name: 'dr_paced_restore_drill_sources.status',
	description:
		'Per-source progress setters can start, restart or refinalize any source; the coordinator normally skips completed sources.',
	initial: 'pending',
	transitions: {
		pending: ['running', 'passed', 'failed'],
		running: ['running', 'passed', 'failed'],
		passed: ['running', 'passed', 'failed'],
		failed: ['running', 'passed', 'failed'],
	},
})
export type D1PacedRestoreDrillSourceStatus = StateOf<
	typeof d1PacedRestoreDrillSourceState
>
