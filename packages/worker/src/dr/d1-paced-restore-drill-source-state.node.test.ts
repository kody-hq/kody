import {
	IllegalStateTransitionError,
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { d1PacedRestoreDrillSourceState } from './d1-paced-restore-drill-source-state.ts'

test('dr_paced_restore_drill_sources.status can start, restart, or refinalize any source', () => {
	expect(
		canHandle(d1PacedRestoreDrillSourceState, 'pending', 'CREATE' as never),
	).toBe(false)
	expect(
		canHandle(d1PacedRestoreDrillSourceState, 'pending', 'START_TABLE'),
	).toBe(true)
	expect(canHandle(d1PacedRestoreDrillSourceState, 'pending', 'PASS')).toBe(
		true,
	)
	expect(canHandle(d1PacedRestoreDrillSourceState, 'pending', 'FAIL')).toBe(
		true,
	)
	for (const from of ['running', 'passed', 'failed'] as const) {
		for (const to of ['running', 'passed', 'failed'] as const) {
			expect(
				canHandle(
					d1PacedRestoreDrillSourceState,
					from,
					(() => {
						switch (to) {
							case 'running':
								return 'START_TABLE' as const
							case 'passed':
								return 'PASS' as const
							case 'failed':
								return 'FAIL' as const
							default:
								throw new IllegalStateTransitionError(
									d1PacedRestoreDrillSourceState.id,
									from,
									{ type: String(to) },
								)
						}
					})(),
				),
			).toBe(true)
		}
	}
	expect(finalStatesOf(d1PacedRestoreDrillSourceState)).toEqual([])
})
