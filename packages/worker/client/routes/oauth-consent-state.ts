import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<OAuthConsentState>>(),
		events: {
			SIGN_IN: types<{
				data: UiPayload<OAuthConsentState, 'signing_in'>
				requestId?: unknown
			}>(),
			DECIDE: types<{
				data: UiPayload<OAuthConsentState, 'deciding'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<OAuthConsentState, 'error'>
				requestId?: unknown
			}>(),
			REDIRECT: types<{
				data: UiPayload<OAuthConsentState, 'redirecting'>
				requestId?: unknown
			}>(),
			GUEST_CREATED: types<{
				data: UiPayload<OAuthConsentState, 'guest'>
				requestId?: unknown
			}>(),
			CLIENT_RESET: types<{
				data: UiPayload<OAuthConsentState, 'reset_complete'>
				requestId?: unknown
			}>(),
			RESET: types<{
				data: UiPayload<OAuthConsentState, 'idle'>
				requestId?: unknown
			}>(),
		},
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
				SIGN_IN: {
					target: 'signing_in',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				DECIDE: {
					target: 'deciding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		signing_in: {
			on: {
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<OAuthConsentState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<OAuthConsentState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		deciding: {
			on: {
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<OAuthConsentState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<OAuthConsentState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
				REDIRECT: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<OAuthConsentState>
						event: { type: 'REDIRECT' } & {
							data: UiPayload<OAuthConsentState, 'redirecting'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'redirecting', context: { data: event.data } }
					},
				},
				GUEST_CREATED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<OAuthConsentState>
						event: { type: 'GUEST_CREATED' } & {
							data: UiPayload<OAuthConsentState, 'guest'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'guest', context: { data: event.data } }
					},
				},
				CLIENT_RESET: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<OAuthConsentState>
						event: { type: 'CLIENT_RESET' } & {
							data: UiPayload<OAuthConsentState, 'reset_complete'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'reset_complete', context: { data: event.data } }
					},
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		error: {
			on: {
				SIGN_IN: {
					target: 'signing_in',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				DECIDE: {
					target: 'deciding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		redirecting: {
			on: {
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		guest: { type: 'final' },
		reset_complete: { type: 'final' },
	},
})
