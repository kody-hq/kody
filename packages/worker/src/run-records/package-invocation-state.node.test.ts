import { expect, test } from 'vitest'
import { packageInvocationState } from './package-invocation-state.ts'

test('invocation claims heartbeat in progress and cannot rewrite a completed or failed response', () => {
	expect(packageInvocationState.can('in_progress', 'in_progress')).toBe(true)
	expect(packageInvocationState.can('in_progress', 'completed')).toBe(true)
	expect(packageInvocationState.can('in_progress', 'failed')).toBe(true)
	expect(packageInvocationState.isTerminal('completed')).toBe(true)
	expect(packageInvocationState.isTerminal('failed')).toBe(true)
	expect(packageInvocationState.can('completed', 'failed')).toBe(false)
	expect(packageInvocationState.can('failed', 'in_progress')).toBe(false)
})
