import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const d1PacedRestoreDrillSourceState = setup({
	schemas: {
		events: { START_TABLE: types<{}>(), PASS: types<{}>(), FAIL: types<{}>() },
	},
}).createMachine({
	id: 'dr_paced_restore_drill_sources.status',
	description:
		'Per-source progress setters can start, restart or refinalize any source; the coordinator normally skips completed sources.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				START_TABLE: { target: 'running' },
				PASS: { target: 'passed' },
				FAIL: { target: 'failed' },
			},
		},
		running: {
			on: {
				START_TABLE: { target: 'running' },
				PASS: { target: 'passed' },
				FAIL: { target: 'failed' },
			},
		},
		passed: {
			on: {
				START_TABLE: { target: 'running' },
				PASS: { target: 'passed' },
				FAIL: { target: 'failed' },
			},
		},
		failed: {
			on: {
				START_TABLE: { target: 'running' },
				PASS: { target: 'passed' },
				FAIL: { target: 'failed' },
			},
		},
	},
})
export type D1PacedRestoreDrillSourceStatus = LifecycleStateOf<
	typeof d1PacedRestoreDrillSourceState
>
