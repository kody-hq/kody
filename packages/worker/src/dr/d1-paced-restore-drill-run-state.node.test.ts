import {
	nextState,
	canHandle,
	finalStatesOf,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'

import { expect, test } from 'vitest'
import { d1PacedRestoreDrillRunState } from './d1-paced-restore-drill-run-state.ts'

test('dr_paced_restore_drill_runs.status finishes a leased run once', () => {
	expect(() =>
		nextState(d1PacedRestoreDrillRunState, 'running', { type: 'PASS' }),
	).not.toThrow()
	expect(() =>
		nextState(d1PacedRestoreDrillRunState, 'running', { type: 'FAIL' }),
	).not.toThrow()
	expect(
		canHandle(d1PacedRestoreDrillRunState, 'running', 'CREATE' as never),
	).toBe(false)
	expect(canHandle(d1PacedRestoreDrillRunState, 'passed', 'FAIL')).toBe(false)
	expect(finalStatesOf(d1PacedRestoreDrillRunState).includes('passed')).toBe(
		true,
	)
	expect(finalStatesOf(d1PacedRestoreDrillRunState).includes('failed')).toBe(
		true,
	)
	expect(() =>
		nextState(d1PacedRestoreDrillRunState, 'passed', {
			type: 'CREATE' as never,
		}),
	).toThrow(IllegalStateTransitionError)
})
