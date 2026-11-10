import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const d1PacedRestoreDrillSourceState = setup({
	types: {
		events: {} as { type: 'START_TABLE' } | { type: 'PASS' } | { type: 'FAIL' },
	},
}).createMachine({
	id: 'dr_paced_restore_drill_sources.status',
	description:
		'Per-source progress setters can start, restart or refinalize any source; the coordinator normally skips completed sources.',
	initial: 'pending',
	states: {
		pending: { on: { START_TABLE: 'running', PASS: 'passed', FAIL: 'failed' } },
		running: { on: { START_TABLE: 'running', PASS: 'passed', FAIL: 'failed' } },
		passed: { on: { START_TABLE: 'running', PASS: 'passed', FAIL: 'failed' } },
		failed: { on: { START_TABLE: 'running', PASS: 'passed', FAIL: 'failed' } },
	},
})
export type D1PacedRestoreDrillSourceStatus = LifecycleStateOf<
	typeof d1PacedRestoreDrillSourceState
>
