import { expect, test } from 'vitest'
import { d1PacedRestoreDrillSourceState } from './d1-paced-restore-drill-source-state.ts'

test('dr_paced_restore_drill_sources.status can start, restart, or refinalize any source', () => {
	expect(d1PacedRestoreDrillSourceState.can('pending', 'pending')).toBe(false)
	expect(d1PacedRestoreDrillSourceState.can('pending', 'running')).toBe(true)
	expect(d1PacedRestoreDrillSourceState.can('pending', 'passed')).toBe(true)
	expect(d1PacedRestoreDrillSourceState.can('pending', 'failed')).toBe(true)
	for (const from of ['running', 'passed', 'failed'] as const) {
		for (const to of ['running', 'passed', 'failed'] as const) {
			expect(d1PacedRestoreDrillSourceState.can(from, to)).toBe(true)
		}
	}
	expect(d1PacedRestoreDrillSourceState.terminal).toEqual([])
})
