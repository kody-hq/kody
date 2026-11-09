import { expect, test } from 'vitest'
import { d1PacedRestoreDrillRunState } from './d1-paced-restore-drill-run-state.ts'

test('dr_paced_restore_drill_runs.status preserves the lifecycle graph', () => {
	expect(d1PacedRestoreDrillRunState.initial).toEqual(['running'])
	expect(d1PacedRestoreDrillRunState.transitions).toEqual({
		running: ['passed', 'failed'],
		passed: [],
		failed: [],
	})
	expect(d1PacedRestoreDrillRunState.terminal).toEqual(['passed', 'failed'])
})
