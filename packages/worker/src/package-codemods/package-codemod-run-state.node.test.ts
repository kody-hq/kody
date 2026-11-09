import { expect, test } from 'vitest'
import { packageCodemodRunState } from './package-codemod-run-state.ts'

test('codemod runs heartbeat, resume from failed or abandoned, and completed continuations may complete or fail', () => {
	expect(packageCodemodRunState.can('running', 'running')).toBe(true)
	expect(packageCodemodRunState.can('running', 'completed')).toBe(true)
	expect(packageCodemodRunState.can('failed', 'running')).toBe(true)
	expect(packageCodemodRunState.can('abandoned', 'running')).toBe(true)
	expect(packageCodemodRunState.can('completed', 'completed')).toBe(true)
	expect(packageCodemodRunState.can('completed', 'failed')).toBe(true)
	expect(packageCodemodRunState.can('failed', 'completed')).toBe(false)
	expect(packageCodemodRunState.can('abandoned', 'completed')).toBe(false)
	expect(packageCodemodRunState.isTerminal('completed')).toBe(false)
})
