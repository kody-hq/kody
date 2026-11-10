import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import { loginState, type AuthFormState } from './login-state.ts'

test('login submission fences a retry until the current request settles or is cancelled', () => {
	expect(canHandle(loginState, 'submitting', 'SUBMIT')).toBe(false)

	const store = createActor(loginState).start()
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
			data: uiContext({ status: 'error', message: 'Try again.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<AuthFormState>(store.getSnapshot())).toEqual({
		status: 'error',
		message: 'Try again.',
	})
	expect(
		sendUiEvent(store, {
			type: 'CONFIRM_USERNAME',
			data: uiContext({
				status: 'confirming',
				message: 'Use this username?',
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<AuthFormState>(store.getSnapshot())).toEqual({
		status: 'confirming',
		message: 'Use this username?',
	})
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'CANCEL',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<AuthFormState>(store.getSnapshot())).toEqual({
		status: 'idle',
	})
})
