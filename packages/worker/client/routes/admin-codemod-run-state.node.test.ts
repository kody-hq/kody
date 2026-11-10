import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	adminCodemodRunState,
	type AdminCodemodRunState,
} from './admin-codemod-run-state.ts'

test('progress survives stopping and failures; starting a retry drops old feedback', () => {
	const store = createActor(adminCodemodRunState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return adminCodemodRunState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
	const progress = { runId: 'run_1', items: [], summary: { changed: 2 } }
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'running', ...progress }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'PROGRESS',
			data: uiContext({
				status: 'running',
				...progress,
				summary: { changed: 3 },
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<AdminCodemodRunState>(store.getSnapshot())).toEqual({
		status: 'running',
		runId: 'run_1',
		items: [],
		summary: { changed: 3 },
	})
	expect(
		sendUiEvent(store, {
			type: 'STOP',
			data: uiContext({
				status: 'stopping',
				...progress,
				summary: { changed: 3 },
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'running', ...progress }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'PROGRESS',
			data: uiContext({
				status: 'stopping',
				...progress,
				summary: { changed: 4 },
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<AdminCodemodRunState>(store.getSnapshot())).toEqual({
		status: 'stopping',
		runId: 'run_1',
		items: [],
		summary: { changed: 4 },
	})
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_ERROR',
			data: uiContext({
				status: 'error',
				...progress,
				summary: { changed: 4 },
				message: 'Try again.',
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({
				status: 'running',
				runId: null,
				items: [],
				summary: {},
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<AdminCodemodRunState>(store.getSnapshot())).toEqual({
		status: 'running',
		runId: null,
		items: [],
		summary: {},
	})
})
