import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { hostCommandState } from './host-command-state.ts'

test('timeout or kill can still fail; a clean exit cannot', () => {
	expect(canHandle(hostCommandState, 'running', 'EXIT')).toBe(true)
	expect(canHandle(hostCommandState, 'running', 'TIMEOUT')).toBe(true)
	expect(canHandle(hostCommandState, 'running', 'KILL')).toBe(true)
	expect(canHandle(hostCommandState, 'timed_out', 'SPAWN_ERROR')).toBe(true)
	expect(canHandle(hostCommandState, 'killed', 'SPAWN_ERROR')).toBe(true)
	expect(finalStatesOf(hostCommandState).includes('exited')).toBe(true)
	expect(finalStatesOf(hostCommandState).includes('failed')).toBe(true)
	expect(canHandle(hostCommandState, 'exited', 'SPAWN_ERROR')).toBe(false)
})
