import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	oauthConsentState,
	type OAuthConsentState,
} from './oauth-consent-state.ts'
test('OAuth sign-in, consent, guest completion and bfcache navigation pin their graph', () => {
	expect(oauthConsentState.transitions).toEqual({
		idle: ['signing_in', 'deciding'],
		signing_in: ['idle', 'error'],
		deciding: ['idle', 'error', 'guest', 'reset_complete', 'redirecting'],
		error: ['signing_in', 'deciding'],
		redirecting: ['idle'],
		guest: [],
		reset_complete: [],
	})
	expect(oauthConsentState.terminal).toEqual(['guest', 'reset_complete'])
})
test('sign-in excludes consent and duplicate clicks, while bfcache releases its fence', () => {
	const store = createStateMachineStore<OAuthConsentState>(oauthConsentState, {
		status: 'idle',
	})
	const controller = new AbortController()
	expect(store.transition({ status: 'signing_in', controller })).toBe(true)
	expect(
		store.transition({ status: 'deciding', decision: 'approve', request: {} }),
	).toBe(false)
	expect(
		store.transition({
			status: 'signing_in',
			controller: new AbortController(),
		}),
	).toBe(false)
	controller.abort()
	expect(store.transition({ status: 'idle' })).toBe(true)
	expect(
		store.transition({ status: 'deciding', decision: 'approve', request: {} }),
	).toBe(true)
	expect(
		store.transition({
			status: 'error',
			message: 'Try again.',
			clientFailure: null,
		}),
	).toBe(true)
	expect(
		store.transition({ status: 'deciding', decision: 'approve', request: {} }),
	).toBe(true)
	expect(store.getSnapshot()).not.toHaveProperty('message')
	expect(store.transition({ status: 'redirecting', decision: 'approve' })).toBe(
		true,
	)
	expect(
		store.transition({ status: 'deciding', decision: 'approve', request: {} }),
	).toBe(false)
	expect(store.transition({ status: 'idle' })).toBe(true)
})
