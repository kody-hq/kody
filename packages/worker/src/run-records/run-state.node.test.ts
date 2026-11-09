import { expect, test } from 'vitest'
import {
	runState,
	runTerminalStatuses,
	type RunTerminalStatus,
} from './run-state.ts'

test('runs.status preserves the lifecycle graph', () => {
	expect(runState.initial).toEqual(['running', 'success', 'error'])
	expect(runState.transitions).toEqual({
		running: ['running', 'success', 'error'],
		success: ['running', 'success', 'error'],
		error: ['running', 'success', 'error'],
	})
	expect(runState.terminal).toEqual([])
	expect(runTerminalStatuses).toEqual([
		'success',
		'error',
	] satisfies ReadonlyArray<RunTerminalStatus>)
})
