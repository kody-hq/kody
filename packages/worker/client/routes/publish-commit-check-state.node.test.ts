import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	publishCommitCheckState,
	type PublishCheckAttempt,
} from './publish-commit-check-state.ts'
test('commit checks pin result replacement and empty-commit transitions', () => {
	expect([...publishCommitCheckState.events].sort()).toEqual([
		'CHECK_COMMIT',
		'CHECK_FAILED',
		'CHECK_PASSED',
		'CHECK_UNAVAILABLE',
		'CLEAR_COMMIT',
	])
	expect(
		publishCommitCheckState.root.initial.target?.map((state) => state.key),
	).toEqual(['idle'])
})
test('empty selections carry no results and retrying drops prior failures', () => {
	const store = createActor(publishCommitCheckState).start()
	expect(
		sendUiEvent(store, {
			type: 'CHECK_COMMIT',
			data: uiContext({ status: 'running', key: 'package:one' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'CHECK_FAILED',
			data: uiContext({
				status: 'failed',
				key: 'package:one',
				failedChecks: [],
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'CHECK_COMMIT',
			data: uiContext({ status: 'running', key: 'package:two' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PublishCheckAttempt>(store.getSnapshot())).not.toHaveProperty(
		'failedChecks',
	)
	expect(
		sendUiEvent(store, {
			type: 'CHECK_UNAVAILABLE',
			data: uiContext({
				status: 'unavailable',
				key: 'package:two',
				error: 'Network error.',
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'CLEAR_COMMIT',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PublishCheckAttempt>(store.getSnapshot())).toEqual({
		status: 'idle',
	})
	expect(
		sendUiEvent(store, {
			type: 'CHECK_PASSED',
			data: uiContext({ status: 'passed', key: 'stale' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
})
