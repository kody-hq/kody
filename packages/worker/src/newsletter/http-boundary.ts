import { Effect } from 'effect'
import { newsletterConfirmLayer, newsletterSignupLayer } from './entrypoints.ts'
import { confirmNewsletterSignup, requestNewsletterSignup } from './signup.ts'

// The HTTP edge of the slice: typed failures become `/newsletter` page params
// here and only here. Defects still reject, so the route answers 500.

type WaitUntil = (promise: Promise<unknown>) => void

const signupErrorParams = {
	SignupRateLimited: 'rate_limited',
	VerificationFailed: 'verification_failed',
	VerificationUnavailable: 'unavailable',
	InvalidEmail: 'invalid_email',
	EmailUnconfigured: 'unavailable',
	DatabaseError: 'unavailable',
} as const

const confirmErrorParams = {
	InvalidConfirmLink: 'invalid_link',
	DatabaseError: 'unavailable',
} as const

export function runNewsletterSignup(input: {
	env: Parameters<typeof newsletterSignupLayer>[0]
	request: Request
	form: Record<string, string>
	waitUntil: WaitUntil
}): Promise<Record<string, string>> {
	return requestNewsletterSignup(input.request, input.form).pipe(
		Effect.as({ status: 'sent' }),
		Effect.catch((error) =>
			Effect.logWarning('newsletter-signup-failed', error).pipe(
				Effect.as({ error: signupErrorParams[error._tag] }),
			),
		),
		Effect.provide(newsletterSignupLayer(input.env, input.waitUntil)),
		Effect.runPromise,
	)
}

export function runNewsletterConfirm(input: {
	env: Parameters<typeof newsletterConfirmLayer>[0]
	request: Request
	token: string | undefined
	waitUntil: WaitUntil
}): Promise<Record<string, string>> {
	return confirmNewsletterSignup(input.request, input.token).pipe(
		Effect.as({ status: 'confirmed' }),
		Effect.catch((error) =>
			Effect.logWarning('newsletter-confirm-failed', error).pipe(
				Effect.as({ error: confirmErrorParams[error._tag] }),
			),
		),
		Effect.provide(newsletterConfirmLayer(input.env, input.waitUntil)),
		Effect.runPromise,
	)
}
