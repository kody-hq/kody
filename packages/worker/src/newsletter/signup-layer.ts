import { Effect, Layer } from 'effect'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { checkPublicFormProtection } from '#app/public-form-protection.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { sendNewsletterConfirmationEmail } from '#worker/email/system-outbound.ts'
import { checkRateLimit } from '#worker/rate-limit.ts'
import {
	ConfirmationSendFailed,
	DatabaseError,
	EmailUnconfigured,
	VerificationFailed,
	VerificationUnavailable,
} from './errors.ts'
import {
	AuditLog,
	ConfirmationMailer,
	HumanVerification,
	RateLimiter,
	outboxLayer,
	type NewsletterEnv,
	type NewsletterServices,
	type WaitUntil,
} from './services.ts'

/** A hung siteverify call fails closed instead of holding the request. */
export const humanVerificationTimeout = '10 seconds'

/** Everything the public sign-up and confirm routes need. */
export function signupLayer(
	env: NewsletterEnv,
	options: { waitUntil?: WaitUntil } = {},
): Layer.Layer<NewsletterServices> {
	const { waitUntil } = options
	return Layer.mergeAll(
		outboxLayer(env, options),
		Layer.succeed(
			RateLimiter,
			RateLimiter.of({
				allow: (key, config) =>
					Effect.tryPromise({
						try: () => checkRateLimit(env.APP_DB, key, config),
						catch: (cause) =>
							new DatabaseError({ operation: 'rate-limit', cause }),
					}).pipe(Effect.map((result) => result.allowed)),
			}),
		),
		Layer.succeed(
			HumanVerification,
			HumanVerification.of({
				verify: ({ request, form }) =>
					Effect.promise(() =>
						checkPublicFormProtection({ env, request, body: form }),
					).pipe(
						Effect.timeoutOrElse({
							duration: humanVerificationTimeout,
							orElse: () =>
								Effect.succeed({ ok: false, timedOut: true } as const),
						}),
						Effect.flatMap(
							(
								result,
							): Effect.Effect<
								void,
								VerificationFailed | VerificationUnavailable
							> =>
								result.ok
									? Effect.void
									: 'status' in result && result.status === 503
										? Effect.fail(new VerificationUnavailable())
										: Effect.fail(
												new VerificationFailed({
													reason: 'timedOut' in result ? 'timeout' : 'rejected',
												}),
											),
						),
					),
			}),
		),
		Layer.succeed(
			ConfirmationMailer,
			ConfirmationMailer.of({
				appBaseUrl: (request) => {
					const config = resolveTransactionalEmailConfig({
						env,
						requestUrl:
							env.WRANGLER_IS_LOCAL_DEV === 'true' ? request.url : undefined,
					})
					return config
						? Effect.succeed(config.appBaseUrl)
						: Effect.fail(new EmailUnconfigured({ email: '' }))
				},
				send: (message) =>
					Effect.tryPromise({
						try: async () => {
							await sendNewsletterConfirmationEmail({
								env,
								...message,
								waitUntil,
							})
						},
						catch: (cause) => new ConfirmationSendFailed({ cause }),
					}).pipe(Effect.asVoid),
			}),
		),
		Layer.succeed(
			AuditLog,
			AuditLog.of({
				// Registered with waitUntil when there is one, so the write is not
				// cut off once the response has gone out.
				record: (event) =>
					Effect.sync(() => {
						const write = logAuditEvent({
							...event,
							db: auditDatabaseFromEnv(env),
						} as Parameters<typeof logAuditEvent>[0])
						if (waitUntil) waitUntil(write)
						else void write
					}),
			}),
		),
	)
}
