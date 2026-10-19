import { formerEmailClaimedSignupMessage } from '#universal/email-claim-errors.ts'

/**
 * Social-login failure codes carried back to `/login?oauthError=<code>`.
 * Shared with the client login route, which maps codes to friendly copy, so
 * no free-form text travels through the redirect URL.
 */
export const oauthLoginErrorMessages = {
	'unknown-provider': 'That sign-in provider is not supported.',
	'not-configured': 'This sign-in provider is not configured yet.',
	'state-mismatch':
		'Your sign-in session expired or did not match. Please try again.',
	denied: 'Sign-in was cancelled.',
	'provider-error':
		'We could not complete sign-in with the provider. Please try again.',
	'no-verified-email':
		'The provider did not share a verified email for your account. Sign in another way first, then connect the provider from this screen while signed in.',
	'connection-conflict':
		'That provider account is already connected to a different user.',
	'email-unverified': 'Verify your email before connecting a sign-in provider.',
	'email-unavailable':
		'This email address cannot be used for a new account. Contact support@kody.codes.',
	'email-invalid':
		'That email address is not valid. Use an address like name@gmail.com, or contact support@kody.codes.',
	'email-typo':
		'That email domain looks mistyped. Check the spelling (for example gmail.com) and try again, or use a different address.',
	'email-disposable':
		'That email domain is a disposable inbox and cannot be used for a Kody account. Use a personal or work address you control.',
	'email-undeliverable':
		'That email domain does not accept mail. Check the domain or use a different address.',
	'email-claimed': formerEmailClaimedSignupMessage,
	'account-error': 'We could not create your account. Please try again.',
	'rate-limited': 'Too many sign-in attempts. Please try again later.',
} as const

export type OauthLoginErrorCode = keyof typeof oauthLoginErrorMessages

export function getOauthLoginErrorMessage(code: string | null) {
	if (!code) return null
	if (code in oauthLoginErrorMessages) {
		return oauthLoginErrorMessages[code as OauthLoginErrorCode]
	}
	return oauthLoginErrorMessages['provider-error']
}
