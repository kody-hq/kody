import { expect, test } from 'vitest'
import { packageCodemodRunState } from './package-codemod-run-state.ts'

test('package_codemod_runs.status preserves the lifecycle graph', () => {
	expect(packageCodemodRunState.initial).toEqual(['running'])
	expect(packageCodemodRunState.transitions).toEqual({
		running: ['running', 'completed', 'failed', 'abandoned'],
		completed: ['completed', 'failed'],
		failed: ['running'],
		abandoned: ['running'],
	})
	expect(packageCodemodRunState.terminal).toEqual([])
})
