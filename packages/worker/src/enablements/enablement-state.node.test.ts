import { expect, test } from 'vitest'
import { enablementState } from './enablement-state.ts'

test('enablements start on, pause and resume, and turn off permanently', () => {
	expect(enablementState.initial).toEqual(['on'])
	expect(enablementState.can('on', 'paused')).toBe(true)
	expect(enablementState.can('paused', 'paused')).toBe(true)
	expect(enablementState.can('paused', 'on')).toBe(true)
	expect(enablementState.can('on', 'off')).toBe(true)
	expect(enablementState.can('paused', 'off')).toBe(true)
	expect(enablementState.isTerminal('off')).toBe(true)
	expect(enablementState.can('off', 'on')).toBe(false)
})
