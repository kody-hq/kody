import { setup, types } from 'xstate'
import type { OAuthAuthorizeClientFailure } from '#universal/oauth-authorize-client-failure.ts'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
export type OAuthAuthorizeDecision =
	| 'approve'
	| 'deny'
	| 'reset-client'
	| 'guest'
export type OAuthConsentState =
	| { status: 'idle' }
	| { status: 'signing_in'; controller: AbortController }
	| { status: 'deciding'; decision: OAuthAuthorizeDecision; request: object }
	| {
			status: 'error'
			message: string
			clientFailure: OAuthAuthorizeClientFailure | null
	  }
	| { status: 'redirecting'; decision: OAuthAuthorizeDecision }
	| { status: 'reset_complete'; message: string }
	| {
			status: 'guest'
			connection: { redirectTo: string; claimUrl: string; expiresAt: string }
	  }

export const oauthConsentState = setup({
	schemas: {
		context: types<UiContext<OAuthConsentState>>(),
		events: {
			SIGN_IN: types<UiEvent<OAuthConsentState, 'signing_in'>>(),
			DECIDE: types<UiEvent<OAuthConsentState, 'deciding'>>(),
			RESPONSE_ERROR: types<UiEvent<OAuthConsentState, 'error'>>(),
			REDIRECT: types<UiEvent<OAuthConsentState, 'redirecting'>>(),
			GUEST_CREATED: types<UiEvent<OAuthConsentState, 'guest'>>(),
			CLIENT_RESET: types<UiEvent<OAuthConsentState, 'reset_complete'>>(),
			RESET: types<UiEvent<OAuthConsentState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'oauth_consent.interaction',
	description:
		'Sign-in and consent decisions are mutually exclusive; cached navigation can release sign-in or redirect fences without replaying a decision.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SIGN_IN: { target: 'signing_in', context: startUi },
				DECIDE: { target: 'deciding', context: startUi },
			},
		},
		signing_in: {
			on: {
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				RESET: { target: 'idle', context: resetUi },
			},
		},
		deciding: {
			on: {
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				REDIRECT: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'redirecting', context: { data: event.data } }
				},
				GUEST_CREATED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'guest', context: { data: event.data } }
				},
				CLIENT_RESET: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'reset_complete', context: { data: event.data } }
				},
				RESET: { target: 'idle', context: resetUi },
			},
		},
		error: {
			on: {
				SIGN_IN: { target: 'signing_in', context: startUi },
				DECIDE: { target: 'deciding', context: startUi },
			},
		},
		redirecting: {
			on: {
				RESET: { target: 'idle', context: resetUi },
			},
		},
		guest: { type: 'final' },
		reset_complete: { type: 'final' },
	},
})
