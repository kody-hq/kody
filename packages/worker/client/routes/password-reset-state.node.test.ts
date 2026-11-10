import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	passwordResetState,
	type PasswordResetState,
} from './password-reset-state.ts'

test('password reset submits once and a retry drops the previous receipt', () => {
	expect(canHandle(passwordResetState, 'submitting', 'SUBMIT')).toBe(false)

	const store = createActor(passwordResetState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return passwordResetState.resolveState({
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
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_OK',
			data: uiContext({ status: 'success', message: 'Check your email.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PasswordResetState>(store.getSnapshot())).toEqual({
		status: 'success',
		message: 'Check your email.',
	})
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PasswordResetState>(store.getSnapshot())).toEqual({
		status: 'submitting',
	})
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_ERROR',
			data: uiContext({ status: 'error', message: 'Try again.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PasswordResetState>(store.getSnapshot())).toEqual({
		status: 'error',
		message: 'Try again.',
	})
})
