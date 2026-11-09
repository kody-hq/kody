import { defineStateMachine } from '@kody-internal/shared/state-machine.ts'
import type { OAuthAuthorizeClientFailure } from '#universal/oauth-authorize-client-failure.ts'
export const oauthConsentState = defineStateMachine({
	name: 'oauth_consent.interaction',
	description:
		'Sign-in and consent decisions are mutually exclusive; cached navigation can release sign-in or redirect fences without replaying a decision.',
	initial: 'idle',
	transitions: {
		idle: ['signing_in', 'deciding'],
		signing_in: ['idle', 'error'],
		deciding: ['idle', 'error', 'guest', 'reset_complete', 'redirecting'],
		error: ['signing_in', 'deciding'],
		redirecting: ['idle'],
		guest: [],
		reset_complete: [],
	},
})
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
