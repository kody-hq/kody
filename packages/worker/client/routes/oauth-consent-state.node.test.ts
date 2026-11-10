import { finalStatesOf } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	oauthConsentState,
	type OAuthConsentState,
} from './oauth-consent-state.ts'
test('OAuth sign-in, consent, guest completion and bfcache navigation pin their graph', () => {
	expect([...oauthConsentState.events].sort()).toEqual([
		'CLIENT_RESET',
		'DECIDE',
		'GUEST_CREATED',
		'REDIRECT',
		'RESET',
		'RESPONSE_ERROR',
		'SIGN_IN',
	])
	expect(finalStatesOf(oauthConsentState)).toEqual(['guest', 'reset_complete'])
})
test('sign-in excludes consent and duplicate clicks, while bfcache releases its fence', () => {
	const store = createActor(oauthConsentState).start()
	const controller = new AbortController()
	expect(
		sendUiEvent(store, {
			type: 'SIGN_IN',
			data: uiContext({ status: 'signing_in', controller }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'DECIDE',
			data: uiContext({ status: 'deciding', decision: 'approve', request: {} })
				.data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'SIGN_IN',
			data: uiContext({
				status: 'signing_in',
				controller: new AbortController(),
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	controller.abort()
	expect(
		sendUiEvent(store, {
			type: 'RESET',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'DECIDE',
			data: uiContext({ status: 'deciding', decision: 'approve', request: {} })
				.data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_ERROR',
			data: uiContext({
				status: 'error',
				message: 'Try again.',
				clientFailure: null,
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'DECIDE',
			data: uiContext({ status: 'deciding', decision: 'approve', request: {} })
				.data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<OAuthConsentState>(store.getSnapshot())).not.toHaveProperty(
		'message',
	)
	expect(
		sendUiEvent(store, {
			type: 'REDIRECT',
			data: uiContext({ status: 'redirecting', decision: 'approve' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'DECIDE',
			data: uiContext({ status: 'deciding', decision: 'approve', request: {} })
				.data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'RESET',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
})
