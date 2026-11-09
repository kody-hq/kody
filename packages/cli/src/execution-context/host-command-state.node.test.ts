import { expect, test } from 'vitest'
import { hostCommandState } from './host-command-state.ts'

test('timeout or kill can still fail; a clean exit cannot', () => {
	expect(hostCommandState.can('running', 'exited')).toBe(true)
	expect(hostCommandState.can('running', 'timed_out')).toBe(true)
	expect(hostCommandState.can('running', 'killed')).toBe(true)
	expect(hostCommandState.can('timed_out', 'failed')).toBe(true)
	expect(hostCommandState.can('killed', 'failed')).toBe(true)
	expect(hostCommandState.isTerminal('exited')).toBe(true)
	expect(hostCommandState.isTerminal('failed')).toBe(true)
	expect(hostCommandState.can('exited', 'failed')).toBe(false)
})
