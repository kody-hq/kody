import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	usernameSignupState,
	type UsernameSignupState,
} from './username-signup-state.ts'

test('username signup cannot submit until confirmed, then a failed submit is retryable', () => {
	expect(canHandle(usernameSignupState, 'idle', 'SUBMIT')).toBe(false)
	expect(canHandle(usernameSignupState, 'submitting', 'SUBMIT')).toBe(false)
	expect(canHandle(usernameSignupState, 'error', 'SUBMIT')).toBe(true)

	const store = createActor(usernameSignupState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return usernameSignupState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'CONFIRM_USERNAME',
			data: uiContext({
				status: 'confirming',
				message: 'Create this username?',
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_ERROR',
			data: uiContext({ status: 'error', message: 'Username taken.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<UsernameSignupState>(store.getSnapshot())).toEqual({
		status: 'error',
		message: 'Username taken.',
	})
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
})
