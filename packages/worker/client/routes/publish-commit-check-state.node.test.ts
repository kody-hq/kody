import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	publishCommitCheckState,
	type PublishCheckAttempt,
} from './publish-commit-check-state.ts'
test('commit checks pin result replacement and empty-commit transitions', () => {
	expect(publishCommitCheckState.transitions).toEqual({
		idle: ['idle', 'running'],
		running: ['idle', 'running', 'passed', 'failed', 'unavailable'],
		passed: ['idle', 'running'],
		failed: ['idle', 'running'],
		unavailable: ['idle', 'running'],
	})
	expect(publishCommitCheckState.initial).toEqual(['idle', 'running'])
})
test('empty selections carry no results and retrying drops prior failures', () => {
	const store = createStateMachineStore<PublishCheckAttempt>(
		publishCommitCheckState,
		{ status: 'idle' },
	)
	expect(store.transition({ status: 'running', key: 'package:one' })).toBe(true)
	expect(
		store.transition({
			status: 'failed',
			key: 'package:one',
			failedChecks: [],
		}),
	).toBe(true)
	expect(store.transition({ status: 'running', key: 'package:two' })).toBe(true)
	expect(store.getSnapshot()).not.toHaveProperty('failedChecks')
	expect(
		store.transition({
			status: 'unavailable',
			key: 'package:two',
			error: 'Network error.',
		}),
	).toBe(true)
	expect(store.transition({ status: 'idle' })).toBe(true)
	expect(store.getSnapshot()).toEqual({ status: 'idle' })
	expect(store.transition({ status: 'passed', key: 'stale' })).toBe(false)
})
