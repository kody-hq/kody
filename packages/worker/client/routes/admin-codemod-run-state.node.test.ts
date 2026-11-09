import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	adminCodemodRunState,
	type AdminCodemodRunState,
} from './admin-codemod-run-state.ts'
test('codemod UI pins paging, stop acknowledgement and retry transitions', () => {
	expect(adminCodemodRunState.transitions).toEqual({
		idle: ['running'],
		running: ['running', 'stopping', 'complete', 'error'],
		stopping: ['stopping', 'complete', 'error'],
		complete: ['running'],
		error: ['running'],
	})
	expect(adminCodemodRunState.terminal).toEqual([])
})
test('progress survives stopping and failures; starting a retry drops old feedback', () => {
	const store = createStateMachineStore<AdminCodemodRunState>(
		adminCodemodRunState,
		{ status: 'idle' },
	)
	const progress = { runId: 'run_1', items: [], summary: { changed: 2 } }
	expect(store.transition({ status: 'running', ...progress })).toBe(true)
	expect(store.transition({ status: 'stopping', ...progress })).toBe(true)
	expect(store.transition({ status: 'running', ...progress })).toBe(false)
	expect(
		store.transition({ status: 'error', ...progress, message: 'Try again.' }),
	).toBe(true)
	expect(
		store.transition({
			status: 'running',
			runId: null,
			items: [],
			summary: {},
		}),
	).toBe(true)
	expect(store.getSnapshot()).toEqual({
		status: 'running',
		runId: null,
		items: [],
		summary: {},
	})
})
