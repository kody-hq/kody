import { finalStatesOf } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	adminCodemodRunState,
	type AdminCodemodRunState,
} from './admin-codemod-run-state.ts'
test('codemod UI pins paging, stop acknowledgement and retry transitions', () => {
	expect([...adminCodemodRunState.events].sort()).toEqual([
		'PROGRESS',
		'RESPONSE_ERROR',
		'RESPONSE_OK',
		'STOP',
		'SUBMIT',
	])
	expect(finalStatesOf(adminCodemodRunState)).toEqual([])
})
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
			type: 'STOP',
			data: uiContext({ status: 'stopping', ...progress }).data,
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
			type: 'RESPONSE_ERROR',
			data: uiContext({ status: 'error', ...progress, message: 'Try again.' })
				.data,
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
