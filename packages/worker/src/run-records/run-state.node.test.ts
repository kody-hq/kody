import { expect, test } from 'vitest'
import { runState, runTerminalStatuses } from './run-state.ts'

test('run replacements stay open; success and error are finished statuses, running is not', () => {
	for (const from of runState.values)
		for (const to of runState.values)
			expect(runState.is(from) && runState.is(to), `${from} -> ${to}`).toBe(
				true,
			)
	const finished = new Set<string>(runTerminalStatuses)
	expect(finished.has('running')).toBe(false)
	expect(finished.has('success')).toBe(true)
	expect(finished.has('error')).toBe(true)
	for (const status of runTerminalStatuses)
		expect(runState.is(status)).toBe(true)
})
