import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	emailVerificationState,
	type EmailVerificationState,
} from './email-verification-state.ts'
test('email verification excludes concurrent resends and checks', () => {
	expect(canHandle(emailVerificationState, 'sending', 'CHECK')).toBe(false)
	expect(canHandle(emailVerificationState, 'checking', 'RESEND')).toBe(false)

	const store = createActor(emailVerificationState).start()
	expect(
		sendUiEvent(store, {
			type: 'RESEND',
			data: uiContext({ status: 'sending' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'CHECK',
			data: uiContext({ status: 'checking' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_OK',
			data: uiContext({ status: 'success', message: 'Sent.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<EmailVerificationState>(store.getSnapshot())).toEqual({
		status: 'success',
		message: 'Sent.',
	})
	expect(
		sendUiEvent(store, {
			type: 'CHECK',
			data: uiContext({ status: 'checking' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<EmailVerificationState>(store.getSnapshot())).toEqual({
		status: 'checking',
	})
	expect(
		sendUiEvent(store, {
			type: 'RESEND',
			data: uiContext({ status: 'sending' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
})
