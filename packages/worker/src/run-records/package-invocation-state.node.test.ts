import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { packageInvocationState } from './package-invocation-state.ts'

test('invocation claims heartbeat in progress and cannot rewrite a completed or failed response', () => {
	expect(canHandle(packageInvocationState, 'in_progress', 'CLAIM')).toBe(true)
	expect(canHandle(packageInvocationState, 'in_progress', 'COMPLETE')).toBe(
		true,
	)
	expect(canHandle(packageInvocationState, 'in_progress', 'FAIL')).toBe(true)
	expect(finalStatesOf(packageInvocationState).includes('completed')).toBe(true)
	expect(finalStatesOf(packageInvocationState).includes('failed')).toBe(true)
	expect(canHandle(packageInvocationState, 'completed', 'FAIL')).toBe(false)
	expect(canHandle(packageInvocationState, 'failed', 'CLAIM')).toBe(false)
})
