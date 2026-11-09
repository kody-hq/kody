import { IllegalStateTransitionError } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { d1PacedRestoreDrillRunState } from './d1-paced-restore-drill-run-state.ts'

test('dr_paced_restore_drill_runs.status finishes a leased run once', () => {
	expect(() =>
		d1PacedRestoreDrillRunState.assert('running', 'passed'),
	).not.toThrow()
	expect(() =>
		d1PacedRestoreDrillRunState.assert('running', 'failed'),
	).not.toThrow()
	expect(d1PacedRestoreDrillRunState.can('running', 'running')).toBe(false)
	expect(d1PacedRestoreDrillRunState.can('passed', 'failed')).toBe(false)
	expect(d1PacedRestoreDrillRunState.isTerminal('passed')).toBe(true)
	expect(d1PacedRestoreDrillRunState.isTerminal('failed')).toBe(true)
	expect(() => d1PacedRestoreDrillRunState.assert('passed', 'running')).toThrow(
		IllegalStateTransitionError,
	)
})
