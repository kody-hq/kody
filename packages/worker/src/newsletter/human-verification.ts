import * as Sentry from '@sentry/cloudflare'
import { Context, Effect, Layer, Schedule, Schema } from 'effect'
import { isNonProductionRuntime } from '#app/deployment-env.ts'

export class VerificationFailed extends Schema.TaggedError<VerificationFailed>()(
	'VerificationFailed',
	{
		reason: Schema.Literals([
			'missing_token',
			'rejected',
			'hostname_mismatch',
			'malformed_response',
			'unreachable',
		]),
	},
) {}

export class VerificationUnavailable extends Schema.TaggedError<VerificationUnavailable>()(
	'VerificationUnavailable',
	{},
) {}

class SiteverifyTransportError extends Schema.TaggedError<SiteverifyTransportError>()(
	'SiteverifyTransportError',
	{
		reason: Schema.Literals(['network', 'timeout', 'server_error']),
		cause: Schema.optional(Schema.Defect()),
	},
) {}

const SiteverifyResponse = Schema.Struct({
	success: Schema.Boolean,
	hostname: Schema.optional(Schema.String),
})

export const siteverifyUrl =
	'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const siteverifyAttemptTimeout = '3 seconds'
/** Outages retry twice, after 200ms then 400ms, before failing closed. */
export const siteverifyRetrySchedule = Schedule.exponential('200 millis')
export const siteverifyRetries = 2

type HumanVerificationEnv = {
	TURNSTILE_SITE_KEY?: string | undefined
	TURNSTILE_SECRET_KEY?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

/** Cloudflare Turnstile siteverify, bound to the hostname that rendered it. */
export class HumanVerification extends Context.Service<
	HumanVerification,
	{
		readonly verify: (input: {
			readonly token: string | undefined
			readonly remoteIp: string | undefined
			readonly expectedHostname: string
		}) => Effect.Effect<void, VerificationFailed | VerificationUnavailable>
	}
>()('kody/newsletter/HumanVerification') {
	static layer(env: HumanVerificationEnv) {
		return Layer.succeed(HumanVerification, makeHumanVerification(env))
	}
}

function makeHumanVerification(
	env: HumanVerificationEnv,
): HumanVerification['Service'] {
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
	const configured = Boolean(env.TURNSTILE_SITE_KEY?.trim() && secretKey)

	const siteverify = (body: URLSearchParams) =>
		Effect.tryPromise({
			try: (signal) =>
				fetch(siteverifyUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body,
					signal,
				}),
			catch: (cause) =>
				new SiteverifyTransportError({ reason: 'network', cause }),
		}).pipe(
			Effect.flatMap((response) =>
				response.status >= 500
					? Effect.fail(
							new SiteverifyTransportError({ reason: 'server_error' }),
						)
					: // An unparsable body decodes as `null` and fails the schema below.
						Effect.promise(() => response.json().catch(() => null)),
			),
			// Aborts the in-flight request through the signal above.
			Effect.timeoutOrElse({
				duration: siteverifyAttemptTimeout,
				orElse: () =>
					Effect.fail(new SiteverifyTransportError({ reason: 'timeout' })),
			}),
			Effect.retry({
				schedule: siteverifyRetrySchedule,
				times: siteverifyRetries,
				while: (error) => error._tag === 'SiteverifyTransportError',
			}),
			// The challenge is configured, so an outage must not become a bypass.
			Effect.catchTag('SiteverifyTransportError', (error) =>
				Effect.logWarning(
					'turnstile-siteverify-unreachable',
					error.reason,
				).pipe(
					Effect.andThen(new VerificationFailed({ reason: 'unreachable' })),
				),
			),
			Effect.flatMap((payload) =>
				Schema.decodeUnknownEffect(SiteverifyResponse)(payload).pipe(
					Effect.mapError(
						() => new VerificationFailed({ reason: 'malformed_response' }),
					),
				),
			),
		)

	return HumanVerification.of({
		verify: Effect.fn('HumanVerification.verify')(function* (input) {
			if (!configured || !secretKey) {
				// Local development, previews, and tests may omit Turnstile. Every
				// other runtime must never fail open.
				if (isNonProductionRuntime(env)) return
				Sentry.captureException(
					new Error(
						'Production public forms require TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.',
					),
					{
						tags: {
							surface: 'public-form-protection',
							reason: 'turnstile-keys-missing',
						},
					},
				)
				return yield* new VerificationUnavailable()
			}
			const token = input.token?.trim()
			if (!token)
				return yield* new VerificationFailed({ reason: 'missing_token' })
			const body = new URLSearchParams({ secret: secretKey, response: token })
			if (input.remoteIp) body.set('remoteip', input.remoteIp)
			const result = yield* siteverify(body)
			if (!result.success) {
				return yield* new VerificationFailed({ reason: 'rejected' })
			}
			// A token is bound to the hostname that rendered the widget; without
			// this a token minted on any site sharing the sitekey would pass.
			if (
				result.hostname?.toLowerCase() !== input.expectedHostname.toLowerCase()
			) {
				yield* Effect.logWarning('turnstile-hostname-mismatch', {
					expected: input.expectedHostname,
					received: result.hostname ?? null,
				})
				return yield* new VerificationFailed({ reason: 'hostname_mismatch' })
			}
		}),
	})
}
