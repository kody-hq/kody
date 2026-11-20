import { DateTime, Effect, Option, Schema, SchemaGetter } from 'effect'
import { toHex } from '@kody-internal/shared/hex.ts'
import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { renderTransactionalEmail } from '#app/email/template.ts'
import {
	honeypotFieldName,
	turnstileResponseFieldName,
} from '#universal/public-form-protection.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { D1 } from '#worker/effect/d1.ts'
import { normalizeAddrSpec } from '#worker/email/address.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import type { RateLimitConfig } from '#worker/rate-limit.ts'
import { NewsletterAudit, type NewsletterAuditEvent } from './audit.ts'
import { recordWhatsNewConsentChange } from './consent-outbox.ts'
import { HumanVerification } from './human-verification.ts'
import { NewsletterMailer } from './mailer.ts'
import { RateLimiter } from './rate-limiter.ts'
import { newsletterSignupState } from './signup-state.ts'

/** Sign-up requests per IP address. */
export const newsletterSignupIpRateLimit: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 10 * 60,
}

/** Confirmation emails per address, so the form cannot flood one inbox. */
export const newsletterSignupEmailRateLimit: RateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 60 * 60,
}

export const newsletterConfirmTokenExpiry = { days: 7 } as const

const confirmGuard = sqlSourcesOf(newsletterSignupState, 'CONFIRM')

const emailPattern = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/

export class InvalidEmail extends Schema.TaggedError<InvalidEmail>()(
	'InvalidEmail',
	{},
) {}

export class SignupRateLimited extends Schema.TaggedError<SignupRateLimited>()(
	'SignupRateLimited',
	{},
) {}

export class EmailUnconfigured extends Schema.TaggedError<EmailUnconfigured>()(
	'EmailUnconfigured',
	{},
) {}

export class InvalidConfirmLink extends Schema.TaggedError<InvalidConfirmLink>()(
	'InvalidConfirmLink',
	{},
) {}

/**
 * A sign-up address: normalized, then held to the sender's own address
 * check, so an address it would refuse fails here instead of reporting a
 * link that is never sent.
 */
export const NewsletterEmail = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform(normalizeEmail),
		encode: SchemaGetter.passthrough(),
	}),
	Schema.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(254),
		Schema.isPattern(emailPattern),
		Schema.makeFilter((email: string) => normalizeAddrSpec(email) !== null),
	),
)

const SignupForm = Schema.Struct({
	email: Schema.optional(Schema.String),
	[honeypotFieldName]: Schema.optional(Schema.String),
	[turnstileResponseFieldName]: Schema.optional(Schema.String),
})

/** Confirmation tokens are 32 random bytes, hex encoded. */
const ConfirmToken = Schema.Trim.check(Schema.isPattern(/^[a-f0-9]{64}$/))

const randomHex = (bytes: number) =>
	Effect.sync(() => toHex(crypto.getRandomValues(new Uint8Array(bytes))))

const sha256Hex = (value: string) =>
	Effect.promise(() =>
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
	).pipe(Effect.map((digest) => toHex(new Uint8Array(digest))))

export function buildNewsletterConfirmEmail(input: {
	appBaseUrl: string
	confirmUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: "Confirm your What's New in Kody subscription",
		preheader: 'One click to confirm, then one short email every other week.',
		heading: "Confirm your What's New in Kody subscription",
		body: [
			"Someone asked to send What's New in Kody to this address: one short email every other week about what's new in Kody.",
			'If that was you, confirm below. You are not subscribed until you do.',
		],
		action: { label: 'Confirm subscription', url: input.confirmUrl },
		afterAction: ['This link expires in 7 days and can only be used once.'],
		footnote:
			'If you did not ask for this, ignore this email and you will not hear from us again.',
	})
}

/**
 * Handle a public sign-up request. Nothing joins the newsletter list here: the
 * address only gets a confirmation link. The result is the same whether the
 * address is new, pending, already subscribed, or throttled per address, so the
 * form cannot be used to learn who is subscribed.
 */
export const requestNewsletterSignup = Effect.fn('requestNewsletterSignup')(
	function* (request: Request, fields: Record<string, string>) {
		const d1 = yield* D1
		const rateLimiter = yield* RateLimiter
		const humanVerification = yield* HumanVerification
		const mailer = yield* NewsletterMailer
		const auditLog = yield* NewsletterAudit
		const ip = getRequestIp(request) ?? undefined
		const audit = (
			event: Pick<NewsletterAuditEvent, 'result' | 'reason' | 'email'>,
		) =>
			auditLog.record({
				action: 'newsletter_signup_request',
				path: '/newsletter',
				ip,
				...event,
			})
		const form = yield* Schema.decodeUnknownEffect(SignupForm)(fields).pipe(
			Effect.orDie,
		)

		// Bots that fill every field get the normal success page and no email.
		if (form[honeypotFieldName]?.trim()) {
			return yield* audit({ result: 'failure', reason: 'honeypot' })
		}

		const ipAllowed = yield* rateLimiter.consume(
			`newsletter-signup:ip:${ip ?? 'unknown'}`,
			newsletterSignupIpRateLimit,
		)
		if (!ipAllowed) {
			yield* audit({ result: 'rate_limited', reason: 'ip' })
			return yield* new SignupRateLimited()
		}

		// Human verification comes before any row or email exists, so a failed
		// or missing Turnstile token never produces a confirmation email.
		yield* humanVerification
			.verify({
				token: form[turnstileResponseFieldName],
				remoteIp: ip,
				expectedHostname: new URL(request.url).hostname,
			})
			.pipe(
				Effect.tapError((error) =>
					audit({
						result: 'failure',
						reason:
							error._tag === 'VerificationUnavailable'
								? 'turnstile_unconfigured'
								: 'turnstile',
					}),
				),
			)

		const email = yield* Schema.decodeUnknownEffect(NewsletterEmail)(
			form.email ?? '',
		).pipe(
			Effect.catchTag('SchemaError', () =>
				audit({ result: 'failure', reason: 'invalid_email' }).pipe(
					Effect.andThen(new InvalidEmail()),
				),
			),
		)

		const subscribed = yield* d1.first({
			name: 'newsletter.findSubscribed',
			sql: `SELECT 1 AS found FROM newsletter_signups WHERE email = ? AND status = 'confirmed'
				UNION ALL
				SELECT 1 AS found FROM users
				WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL
					AND email_verified_at IS NOT NULL AND whats_new_email_opt_in = 1
				LIMIT 1`,
			params: [email, email],
			row: Schema.Struct({ found: Schema.Number }),
		})
		if (Option.isSome(subscribed)) {
			return yield* audit({
				result: 'success',
				reason: 'already_subscribed',
				email,
			})
		}

		const emailAllowed = yield* rateLimiter.consume(
			`newsletter-signup:email:${yield* sha256Hex(email)}`,
			newsletterSignupEmailRateLimit,
		)
		if (!emailAllowed) {
			return yield* audit({ result: 'rate_limited', reason: 'email', email })
		}

		const config = mailer.config(request.url)
		if (Option.isNone(config)) {
			yield* audit({ result: 'failure', reason: 'email_unconfigured', email })
			return yield* new EmailUnconfigured()
		}

		const now = yield* DateTime.now
		const nowIso = DateTime.formatIso(now)
		const token = yield* randomHex(32)
		yield* d1.run({
			name: 'newsletter.upsertPendingSignup',
			sql: `INSERT INTO newsletter_signups (stable_id, email, token_hash, token_expires_at, requested_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(email) DO UPDATE SET
					token_hash = excluded.token_hash,
					token_expires_at = excluded.token_expires_at,
					requested_at = excluded.requested_at,
					updated_at = excluded.updated_at`,
			params: [
				yield* randomHex(32),
				email,
				yield* sha256Hex(token),
				DateTime.toEpochMillis(DateTime.add(now, newsletterConfirmTokenExpiry)),
				nowIso,
				nowIso,
			],
		})

		const confirmUrl = new URL('/newsletter/confirm', config.value.appBaseUrl)
		confirmUrl.searchParams.set('token', token)
		const message = buildNewsletterConfirmEmail({
			appBaseUrl: config.value.appBaseUrl,
			confirmUrl: confirmUrl.toString(),
		})
		yield* mailer
			.sendConfirmation({
				to: email,
				subject: message.subject,
				html: message.html,
				text: message.text,
			})
			.pipe(
				Effect.andThen(
					audit({ result: 'success', reason: 'confirmation_sent', email }),
				),
				// A suppressed or rejected recipient looks like any other request, so
				// the form does not reveal delivery state. Outages are reported.
				Effect.catchTag('MailDeliveryError', ({ cause }) =>
					Effect.logWarning(
						'newsletter-signup-confirm-email-failed',
						cause instanceof Error
							? cause.message.replaceAll(email, '[email]')
							: '',
					).pipe(
						Effect.andThen(
							audit({ result: 'failure', reason: 'send_failed', email }),
						),
					),
				),
			)
	},
)

const ConfirmedSignupRow = Schema.Struct({
	email: Schema.String,
	stable_id: Schema.String,
})

/**
 * Confirm a sign-up from its emailed link. This is the only step that adds an
 * address to the newsletter list. Tokens are single use.
 */
export const confirmNewsletterSignup = Effect.fn('confirmNewsletterSignup')(
	function* (request: Request, rawToken: string | undefined) {
		const d1 = yield* D1
		const auditLog = yield* NewsletterAudit
		const ip = getRequestIp(request) ?? undefined
		const now = yield* DateTime.now
		const nowIso = DateTime.formatIso(now)
		const signup = yield* Schema.decodeUnknownOption(ConfirmToken)(
			rawToken,
		).pipe(
			Option.match({
				onNone: () => Effect.succeedNone,
				onSome: (token) =>
					sha256Hex(token).pipe(
						Effect.flatMap((tokenHash) =>
							d1.first({
								name: 'newsletter.confirmSignup',
								sql: `UPDATE newsletter_signups
									SET status = 'confirmed', source = 'newsletter_page', confirmed_at = ?, updated_at = ?, token_hash = NULL, token_expires_at = NULL
									WHERE token_hash = ? AND token_expires_at > ? AND status IN ${confirmGuard}
									RETURNING email, stable_id`,
								params: [
									nowIso,
									nowIso,
									tokenHash,
									DateTime.toEpochMillis(now),
								],
								row: ConfirmedSignupRow,
							}),
						),
					),
			}),
		)
		if (Option.isNone(signup)) {
			yield* auditLog.record({
				action: 'newsletter_signup_confirm',
				result: 'failure',
				path: '/newsletter/confirm',
				ip,
				reason: 'invalid_link',
			})
			return yield* new InvalidConfirmLink()
		}
		// An address that already has a verified account keeps its consent on the
		// account, which is what account settings and exports read.
		const account = yield* d1.first({
			name: 'newsletter.optInVerifiedAccount',
			sql: `UPDATE users SET whats_new_email_opt_in = 1, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = 'email_link'
				WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL AND email_verified_at IS NOT NULL
				RETURNING stable_user_id`,
			params: [nowIso, signup.value.email],
			row: Schema.Struct({ stable_user_id: Schema.String }),
		})
		// The page already confirmed; telling subscribers never fails the confirm.
		yield* recordWhatsNewConsentChange({
			stableUserId: Option.match(account, {
				onSome: (row) => row.stable_user_id,
				onNone: () => signup.value.stable_id,
			}),
			optedIn: true,
			source: 'newsletter_page',
			occurredAt: nowIso,
		}).pipe(
			Effect.catch((error) =>
				Effect.logError('whats-new-consent-outbox-record-failed', error),
			),
		)
		yield* auditLog.record({
			action: 'newsletter_signup_confirm',
			result: 'success',
			path: '/newsletter/confirm',
			ip,
			email: signup.value.email,
		})
	},
)
