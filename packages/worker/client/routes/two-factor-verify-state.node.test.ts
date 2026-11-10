import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	twoFactorVerifyState,
	type TwoFactorVerifyState,
} from './two-factor-verify-state.ts'

test('two-factor verification fences submission and a retry drops failure feedback', () => {
	expect(canHandle(twoFactorVerifyState, 'submitting', 'SUBMIT')).toBe(false)
	expect(
		canHandle(twoFactorVerifyState, 'submitting', 'VALIDATION_ERROR'),
	).toBe(false)

	const store = createActor(twoFactorVerifyState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return twoFactorVerifyState.resolveState({
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
			type: 'RESPONSE_ERROR',
			data: uiContext({ status: 'error', message: 'Invalid code.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<TwoFactorVerifyState>(store.getSnapshot())).toEqual({
		status: 'error',
		message: 'Invalid code.',
	})
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<TwoFactorVerifyState>(store.getSnapshot())).toEqual({
		status: 'submitting',
	})
})
