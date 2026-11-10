import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { enablementState } from './enablement-state.ts'

test('enablements start on, pause and resume, and turn off permanently', () => {
	expect([enablementState.config.initial]).toEqual(['on'])
	expect(canHandle(enablementState, 'on', 'PAUSE')).toBe(true)
	expect(canHandle(enablementState, 'paused', 'PAUSE')).toBe(true)
	expect(canHandle(enablementState, 'paused', 'RESUME')).toBe(true)
	expect(canHandle(enablementState, 'on', 'DISABLE')).toBe(true)
	expect(canHandle(enablementState, 'paused', 'DISABLE')).toBe(true)
	expect(finalStatesOf(enablementState).includes('off')).toBe(true)
	expect(canHandle(enablementState, 'off', 'RESUME')).toBe(false)
})
