import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { packageCodemodRunState } from './package-codemod-run-state.ts'

test('codemod runs heartbeat, resume from failed or abandoned, and completed continuations may complete or fail', () => {
	expect(canHandle(packageCodemodRunState, 'running', 'CONTINUE')).toBe(true)
	expect(canHandle(packageCodemodRunState, 'running', 'COMPLETE')).toBe(true)
	expect(canHandle(packageCodemodRunState, 'failed', 'CONTINUE')).toBe(true)
	expect(canHandle(packageCodemodRunState, 'abandoned', 'CONTINUE')).toBe(true)
	expect(canHandle(packageCodemodRunState, 'completed', 'COMPLETE')).toBe(true)
	expect(canHandle(packageCodemodRunState, 'completed', 'FAIL')).toBe(true)
	expect(canHandle(packageCodemodRunState, 'failed', 'COMPLETE')).toBe(false)
	expect(canHandle(packageCodemodRunState, 'abandoned', 'COMPLETE')).toBe(false)
	expect(finalStatesOf(packageCodemodRunState).includes('completed')).toBe(
		false,
	)
})
