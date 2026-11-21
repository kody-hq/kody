import { Effect, Layer } from 'effect'
import { Background } from '#worker/effect/background.ts'
import { D1 } from '#worker/effect/d1.ts'
import { WorkerObservability } from '#worker/effect/observability.ts'
import { NewsletterAudit } from './audit.ts'
import {
	consentOutboxProducerLayer,
	type ConsentOutboxEnv,
} from './consent-outbox.ts'
import { HumanVerification } from './human-verification.ts'
import { NewsletterMailer } from './mailer.ts'
import { RateLimiter } from './rate-limiter.ts'
import { confirmNewsletterSignup, requestNewsletterSignup } from './signup.ts'

// The HTTP edge of the slice: typed failures become `/newsletter` page params
// here and only here. Defects still reject, so the route answers 500.

type WaitUntil = (promise: Promise<unknown>) => void

// One Layer per route, each built from only the bindings it reads.

/** `POST /newsletter` */
function newsletterSignupLayer(
	env: Parameters<typeof HumanVerification.layer>[0] &
		Parameters<typeof NewsletterMailer.layer>[0] &
		Parameters<typeof NewsletterAudit.layer>[0] &
		Pick<Env, 'APP_DB'>,
	waitUntil: WaitUntil,
) {
	return Layer.mergeAll(
		RateLimiter.layer,
		HumanVerification.layer(env),
		NewsletterMailer.layer(env),
		NewsletterAudit.layer(env),
	).pipe(
		Layer.provideMerge(D1.layer(env.APP_DB)),
		Layer.provide(Background.layer(waitUntil)),
		Layer.provideMerge(WorkerObservability),
	)
}

/** `POST /newsletter/confirm` */
function newsletterConfirmLayer(env: ConsentOutboxEnv, waitUntil: WaitUntil) {
	return Layer.mergeAll(
		NewsletterAudit.layer(env),
		consentOutboxProducerLayer(env),
	).pipe(
		Layer.provideMerge(D1.layer(env.APP_DB)),
		Layer.provide(Background.layer(waitUntil)),
		Layer.provideMerge(WorkerObservability),
	)
}

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
