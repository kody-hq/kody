import { expect, test } from 'vitest'
import { runState, runTerminalStatuses } from './run-state.ts'

test('run replacements stay open; success and error are finished statuses, running is not', () => {
	for (const from of runState.states)
		for (const to of runState.states)
			expect(runState.can(from, to), `${from} -> ${to}`).toBe(true)
	expect(runTerminalStatuses.includes('running')).toBe(false)
	expect(runTerminalStatuses.includes('success')).toBe(true)
	expect(runTerminalStatuses.includes('error')).toBe(true)
	for (const status of runTerminalStatuses)
		expect(runState.is(status)).toBe(true)
})
