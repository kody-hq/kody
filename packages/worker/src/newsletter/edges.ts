import { Effect, Layer, Schema } from 'effect'
import { Background } from '#worker/effect/background.ts'
import { AuditLog } from '#worker/effect/audit.ts'
import { D1 } from '#worker/effect/d1.ts'
import {
	PublicFormProtection,
	type PublicFormProtectionEnv,
} from '#worker/effect/public-form-protection.ts'
import { RateLimiter } from '#worker/effect/rate-limit.ts'
import { runtimePerBinding } from '#worker/effect/runtime.ts'
import {
	type ConsentOutboxQueue,
	consentOutboxLayer,
	deliverConsentOutboxRow,
	WhatsNewConsentOutboxQueueMessage,
} from '#worker/newsletter/consent-outbox.ts'
import {
	type MailerEnv,
	NewsletterMailer,
	type PackageSubscribers,
} from '#worker/newsletter/services.ts'
import {
	confirmNewsletterSignup,
	NewsletterForm,
	requestNewsletterSignup,
} from '#worker/newsletter/signup.ts'

type WaitUntil = (promise: Promise<unknown>) => void
type AuditEnv = Parameters<typeof AuditLog.layer>[0]

export type SignupEnv = MailerEnv &
	AuditEnv &
	PublicFormProtectionEnv & { APP_DB: D1Database }

/** `POST /newsletter` needs no queue or package dispatch. */
const signupRuntime = runtimePerBinding((env: SignupEnv) => {
	const d1 = D1.layer(env.APP_DB)
	return Layer.mergeAll(
		d1,
		RateLimiter.layer.pipe(Layer.provide(d1)),
		PublicFormProtection.layer(env),
		NewsletterMailer.layer(env),
		AuditLog.layer(env),
	)
})

/** `POST /newsletter/confirm` needs the outbox, not Turnstile or mail. */
const confirmRuntime = runtimePerBinding((env: Env) =>
	Layer.merge(consentOutboxLayer(env), AuditLog.layer(env)),
)

/** The package-events queue consumer needs only D1 and package dispatch. */
const consentQueueRuntime = runtimePerBinding(consentOutboxLayer)

export type NewsletterRedirect =
	| { readonly status: 'sent' | 'confirmed' }
	| {
			readonly error:
				| 'invalid_email'
				| 'rate_limited'
				| 'unavailable'
				| 'verification_failed'
				| 'invalid_link'
	  }

/**
 * Route edges. Each failure maps to a redirect here, exhaustively: the
 * annotated `never` error channel makes an unmapped new failure a type error.
 */
export function handleNewsletterSignup(input: {
	env: SignupEnv
	request: Request
	form: Readonly<Record<string, unknown>>
	waitUntil: WaitUntil
}): Promise<NewsletterRedirect> {
	const program: Effect.Effect<
		NewsletterRedirect,
		never,
		D1 | RateLimiter | PublicFormProtection | NewsletterMailer | AuditLog
	> = Schema.decodeUnknownEffect(NewsletterForm)(input.form).pipe(
		Effect.flatMap((form) =>
			requestNewsletterSignup({ request: input.request, form }),
		),
		Effect.as<NewsletterRedirect>({ status: 'sent' }),
		Effect.catchTags({
			SchemaError: () => redirectError('invalid_email'),
			InvalidNewsletterEmail: () => redirectError('invalid_email'),
			NewsletterSignupRateLimited: () => redirectError('rate_limited'),
			HumanVerificationFailed: () => redirectError('verification_failed'),
			HumanVerificationUnavailable: () => redirectError('unavailable'),
			NewsletterEmailUnconfigured: () => redirectError('unavailable'),
			DatabaseError: (error) =>
				Effect.logError('newsletter-signup-database-error', error).pipe(
					Effect.andThen(redirectError('unavailable')),
				),
		}),
		Effect.provide(Background.layer(input.waitUntil)),
	)
	return signupRuntime(input.env).runPromise(program)
}

export function handleNewsletterConfirm(input: {
	env: Env
	request: Request
	token: string | undefined
	waitUntil: WaitUntil
}): Promise<NewsletterRedirect> {
	const program: Effect.Effect<
		NewsletterRedirect,
		never,
		D1 | ConsentOutboxQueue | AuditLog
	> = confirmNewsletterSignup(input).pipe(
		Effect.as<NewsletterRedirect>({ status: 'confirmed' }),
		Effect.catchTags({
			InvalidConfirmLink: () => redirectError('invalid_link'),
			DatabaseError: (error) =>
				Effect.logError('newsletter-confirm-database-error', error).pipe(
					Effect.andThen(redirectError('unavailable')),
				),
		}),
		Effect.provide(Background.layer(input.waitUntil)),
	)
	return confirmRuntime(input.env).runPromise(program)
}

const redirectError = (
	error: Extract<NewsletterRedirect, { error: unknown }>['error'],
) => Effect.succeed<NewsletterRedirect>({ error })

type QueueDecision = 'ack' | 'retry'

/**
 * Queue edge, one message at a time and in order: two changes for one
 * recipient must reach subscribers in the order they happened. A body that
 * fails the shared schema is acked (retrying cannot fix it); every delivery
 * failure retries.
 */
export function handleConsentOutboxMessages(input: {
	env: Env
	messages: ReadonlyArray<Message<unknown>>
	waitUntil: WaitUntil
	retryDelaySeconds: number
}) {
	const handleOne = (queueMessage: Message<unknown>) => {
		const decision: Effect.Effect<
			QueueDecision,
			never,
			D1 | PackageSubscribers | Background
		> = Schema.decodeUnknownEffect(WhatsNewConsentOutboxQueueMessage)(
			queueMessage.body,
		).pipe(
			Effect.flatMap((message) => deliverConsentOutboxRow(message.outboxId)),
			Effect.as<QueueDecision>('ack'),
			Effect.catchTags({
				SchemaError: (error) =>
					Effect.logError(
						'whats-new-consent-outbox-message-invalid',
						error,
					).pipe(Effect.as<QueueDecision>('ack')),
				DatabaseError: retryAfter,
				ConsentDeliveryIncomplete: retryAfter,
				PackageDispatchFailed: retryAfter,
			}),
			Effect.annotateLogs({ queueMessageId: queueMessage.id }),
			Effect.withSpan('ConsentOutbox.queueMessage', {
				attributes: { 'queue.message_id': queueMessage.id },
			}),
		)
		return decision.pipe(
			Effect.tap((result) =>
				Effect.sync(() =>
					result === 'ack'
						? queueMessage.ack()
						: queueMessage.retry({ delaySeconds: input.retryDelaySeconds }),
				),
			),
		)
	}
	return consentQueueRuntime(input.env).runPromise(
		Effect.forEach(input.messages, handleOne, { discard: true }).pipe(
			Effect.provide(Background.layer(input.waitUntil)),
		),
	)
}

const retryAfter = (error: { readonly _tag: string }) =>
	Effect.logError(
		'whats-new-consent-outbox-queue-processing-failed',
		error,
	).pipe(Effect.as<QueueDecision>('retry'))
