import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
import type { OAuthAuthorizeClientFailure } from '#universal/oauth-authorize-client-failure.ts'
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
	types: {
		context: {} as UiContext<OAuthConsentState>,
		events: {} as
			| {
					type: 'SIGN_IN'
					data: UiPayload<OAuthConsentState, 'signing_in'>
					requestId?: unknown
			  }
			| {
					type: 'DECIDE'
					data: UiPayload<OAuthConsentState, 'deciding'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<OAuthConsentState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'REDIRECT'
					data: UiPayload<OAuthConsentState, 'redirecting'>
					requestId?: unknown
			  }
			| {
					type: 'GUEST_CREATED'
					data: UiPayload<OAuthConsentState, 'guest'>
					requestId?: unknown
			  }
			| {
					type: 'CLIENT_RESET'
					data: UiPayload<OAuthConsentState, 'reset_complete'>
					requestId?: unknown
			  }
			| {
					type: 'RESET'
					data: UiPayload<OAuthConsentState, 'idle'>
					requestId?: unknown
			  },
	},
	guards: {
		currentRequest: ({ context, event }) =>
			context.requestId === event.requestId,
	},
	actions: {
		update: assign({ data: ({ event }) => event.data }),
		start: assign({
			data: ({ event }) => event.data,
			requestId: ({ event }) => event.requestId,
		}),
		reset: assign({ data: ({ event }) => event.data, requestId: undefined }),
	},
}).createMachine({
	id: 'oauth_consent.interaction',
	description:
		'Sign-in and consent decisions are mutually exclusive; cached navigation can release sign-in or redirect fences without replaying a decision.',
	initial: 'idle',
	context: { data: {} as UiData<OAuthConsentState>, requestId: undefined },
	states: {
		idle: {
			on: {
				SIGN_IN: { target: 'signing_in', actions: 'start' },
				DECIDE: { target: 'deciding', actions: 'start' },
			},
		},
		signing_in: {
			on: {
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		deciding: {
			on: {
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				REDIRECT: {
					target: 'redirecting',
					guard: 'currentRequest',
					actions: 'update',
				},
				GUEST_CREATED: {
					target: 'guest',
					guard: 'currentRequest',
					actions: 'update',
				},
				CLIENT_RESET: {
					target: 'reset_complete',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		error: {
			on: {
				SIGN_IN: { target: 'signing_in', actions: 'start' },
				DECIDE: { target: 'deciding', actions: 'start' },
			},
		},
		redirecting: { on: { RESET: { target: 'idle', actions: 'reset' } } },
		guest: { type: 'final' },
		reset_complete: { type: 'final' },
	},
})
