/**
 * `?formError=` codes the server-rendered `/login` and `/verify` forms show
 * after a plain HTML form POST (ADR 0094). Codes, not server text, travel in
 * the URL so nobody can put their own sentence on Kody's sign-in page.
 */
export type AuthFormError =
	| 'invalid'
	| 'human_check'
	| 'rate_limited'
	| 'unavailable'
	| 'expired'

/** The sentence a server-rendered auth form shows for `?formError=`. */
export function authFormErrorMessage(value: string | null | undefined) {
	switch (value as AuthFormError | null) {
		case 'invalid':
			return 'That did not work. Check what you entered and try again.'
		case 'human_check':
			return 'Complete the human check, then try again. If it does not appear in this browser, sign in on another device instead.'
		case 'rate_limited':
			return 'Too many attempts. Wait a few minutes, then try again.'
		case 'unavailable':
			return 'Sign-in is unavailable right now. Try again in a minute.'
		case 'expired':
			return 'Your sign-in expired. Sign in again.'
		default:
			return null
	}
}
