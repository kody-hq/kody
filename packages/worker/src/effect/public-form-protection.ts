import * as Sentry from '@sentry/cloudflare'
import { Context, Effect, Layer, Predicate, Schedule, Schema } from 'effect'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { runPromiseEdge } from '#worker/effect/observability.ts'
import {
	honeypotFieldName,
	turnstileResponseFieldName,
} from '#universal/public-form-protection.ts'

export class HumanVerificationFailed extends Schema.TaggedError<HumanVerificationFailed>()(
	'HumanVerificationFailed',
	{
		reason: Schema.Literals([
			'honeypot',
			'missing_token',
			'rejected',
			'hostname_mismatch',
			'outage',
		]),
	},
) {}

/** Production is missing its Turnstile keys: refuse, never fail open. */
export class HumanVerificationUnavailable extends Schema.TaggedError<HumanVerificationUnavailable>()(
	'HumanVerificationUnavailable',
	{},
) {}

class SiteverifyUnreachable extends Schema.TaggedError<SiteverifyUnreachable>()(
	'SiteverifyUnreachable',
	{
		reason: Schema.Literals(['network', 'timeout', 'server_error']),
		cause: Schema.Defect(),
	},
) {}

export const SiteverifyResponse = Schema.Struct({
	success: Schema.Boolean,
	hostname: Schema.optional(Schema.String),
	'error-codes': Schema.optional(Schema.Array(Schema.String)),
})

export type PublicFormProtectionEnv = {
	TURNSTILE_SITE_KEY?: string | undefined
	TURNSTILE_SECRET_KEY?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

export type PublicFormInput = {
	readonly request: Request
	readonly form: Readonly<Record<string, unknown>>
}

export const siteverifyUrl =
	'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const siteverifyAttemptTimeout = '4 seconds'
/** Two retries after the first attempt: 250ms, then 500ms. */
export const siteverifyRetries = 2
const siteverifyBackoff = Schedule.exponential('250 millis')

const readTrimmed = (form: PublicFormInput['form'], name: string) => {
	const value = form[name]
	return Predicate.isString(value) ? value.trim() : ''
}

/**
 * Honeypot plus Cloudflare Turnstile `siteverify`. Each attempt is bounded and
 * aborted on timeout; transport and 5xx failures retry with the same
 * `idempotency_key`, so a retry after a lost response cannot be refused as a
 * reused token. An outage after retries fails closed.
 */
export class PublicFormProtection extends Context.Service<
	PublicFormProtection,
	{
		verify(
			input: PublicFormInput,
		): Effect.Effect<
			void,
			HumanVerificationFailed | HumanVerificationUnavailable
		>
	}
>()('kody/effect/PublicFormProtection') {
	static readonly layer = (env: PublicFormProtectionEnv) =>
		Layer.succeed(PublicFormProtection, makePublicFormProtection(env))
}

const siteverify = Effect.fn('PublicFormProtection.siteverify')(function* (
	body: URLSearchParams,
) {
	const response = yield* Effect.tryPromise({
		try: async (signal) => {
			const response = await fetch(siteverifyUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
				signal,
			})
			const json: unknown = await response.json().catch(() => null)
			return { status: response.status, json }
		},
		catch: (cause) => new SiteverifyUnreachable({ reason: 'network', cause }),
	}).pipe(
		Effect.timeoutOrElse({
			duration: siteverifyAttemptTimeout,
			orElse: () =>
				Effect.fail(
					new SiteverifyUnreachable({ reason: 'timeout', cause: null }),
				),
		}),
	)
	yield* Effect.annotateCurrentSpan('http.status_code', response.status)
	if (response.status >= 500) {
		return yield* new SiteverifyUnreachable({
			reason: 'server_error',
			cause: response.status,
		})
	}
	return yield* Schema.decodeUnknownEffect(SiteverifyResponse)(response.json)
})

function makePublicFormProtection(
	env: PublicFormProtectionEnv,
): PublicFormProtection['Service'] {
	return PublicFormProtection.of({
		verify: Effect.fn('PublicFormProtection.verify')(function* ({
			request,
			form,
		}) {
			if (readTrimmed(form, honeypotFieldName)) {
				return yield* new HumanVerificationFailed({ reason: 'honeypot' })
			}
			const siteKey = env.TURNSTILE_SITE_KEY?.trim()
			const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
			// Local development, previews, and tests may omit Turnstile. Every
			// other runtime (including unset SENTRY_ENVIRONMENT) refuses.
			if (!siteKey || !secretKey) {
				if (isNonProductionRuntime(env)) return
				yield* Effect.sync(() =>
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
					),
				)
				return yield* new HumanVerificationUnavailable()
			}
			const token = readTrimmed(form, turnstileResponseFieldName)
			if (!token) {
				return yield* new HumanVerificationFailed({ reason: 'missing_token' })
			}
			// One key for every attempt; created outside the retry on purpose.
			const idempotencyKey = yield* Effect.sync(() => crypto.randomUUID())
			const body = new URLSearchParams({
				secret: secretKey,
				response: token,
				idempotency_key: idempotencyKey,
			})
			const ip = getRequestIp(request)
			if (ip) body.set('remoteip', ip)

			const payload = yield* siteverify(body).pipe(
				Effect.retry({
					schedule: siteverifyBackoff,
					times: siteverifyRetries,
					while: (error) => error._tag === 'SiteverifyUnreachable',
				}),
				Effect.tapError((error) =>
					Effect.logWarning('turnstile-siteverify-unavailable', error),
				),
				Effect.mapError(
					() => new HumanVerificationFailed({ reason: 'outage' }),
				),
			)
			if (!payload.success) {
				return yield* new HumanVerificationFailed({ reason: 'rejected' })
			}
			// Without this check a token minted on any other site using this
			// widget key (a preview deploy, a phishing page) would be accepted.
			const expected = new URL(request.url).hostname.toLowerCase()
			if (payload.hostname?.toLowerCase() !== expected) {
				yield* Effect.logWarning('turnstile-hostname-mismatch', {
					expected,
					received: payload.hostname ?? null,
				})
				return yield* new HumanVerificationFailed({
					reason: 'hostname_mismatch',
				})
			}
		}),
	})
}

export type PublicFormProtectionResult =
	| { ok: true }
	| { ok: false; error: string; status?: number }

const failureMessages: Record<HumanVerificationFailed['reason'], string> = {
	honeypot: 'Unable to submit this form.',
	missing_token: 'Please complete the human verification challenge.',
	rejected: 'Human verification failed. Please try again.',
	hostname_mismatch: 'Human verification failed. Please try again.',
	outage: 'Human verification failed. Please try again.',
}

/** Promise edge for the forms outside the Effect slice. */
export function runPublicFormProtection(input: {
	env: PublicFormProtectionEnv
	request: Request
	body: Readonly<Record<string, unknown>>
}): Promise<PublicFormProtectionResult> {
	return runPromiseEdge(
		PublicFormProtection.use((protection) =>
			protection.verify({ request: input.request, form: input.body }),
		).pipe(
			Effect.as<PublicFormProtectionResult>({ ok: true }),
			Effect.catchTags({
				HumanVerificationFailed: (error) =>
					Effect.succeed<PublicFormProtectionResult>({
						ok: false,
						error: failureMessages[error.reason],
					}),
				HumanVerificationUnavailable: () =>
					Effect.succeed<PublicFormProtectionResult>({
						ok: false,
						error:
							'Human verification is not configured on this deployment. Please try again later.',
						status: 503,
					}),
			}),
			Effect.provide(PublicFormProtection.layer(input.env)),
		),
	)
}
