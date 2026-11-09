import { expect, test } from 'vitest'
import { d1PacedRestoreDrillSourceState } from './d1-paced-restore-drill-source-state.ts'

test('dr_paced_restore_drill_sources.status preserves the accepted lifecycle graph', () => {
	expect(d1PacedRestoreDrillSourceState.initial).toEqual(['pending'])
	expect(d1PacedRestoreDrillSourceState.transitions).toEqual({
		pending: ['running', 'passed', 'failed'],
		running: ['running', 'passed', 'failed'],
		passed: ['running', 'passed', 'failed'],
		failed: ['running', 'passed', 'failed'],
	})
	expect(d1PacedRestoreDrillSourceState.terminal).toEqual([])
})
