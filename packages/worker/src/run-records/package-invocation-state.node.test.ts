import { expect, test } from 'vitest'
import { packageInvocationState } from './package-invocation-state.ts'

test('package_invocation_ledger.status preserves the accepted lifecycle graph', () => {
	expect(packageInvocationState.initial).toEqual(['in_progress'])
	expect(packageInvocationState.transitions).toEqual({
		in_progress: ['in_progress', 'completed', 'failed'],
		completed: [],
		failed: [],
	})
	expect(packageInvocationState.terminal).toEqual(['completed', 'failed'])
})
