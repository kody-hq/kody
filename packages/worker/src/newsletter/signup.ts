import { DateTime, Effect, Option, Schema } from 'effect'
import { toHex } from '@kody-internal/shared/hex.ts'
import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { renderTransactionalEmail } from '#app/email/template.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { AuditLog, type AuditEvent } from '#worker/effect/audit.ts'
import { D1, sql } from '#worker/effect/d1.ts'
import { PublicFormProtection } from '#worker/effect/public-form-protection.ts'
import { RateLimiter, type RateLimitConfig } from '#worker/effect/rate-limit.ts'
import { normalizeAddrSpec } from '#worker/email/address.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { recordConsentChange } from '#worker/newsletter/consent-outbox.ts'
import { NewsletterMailer } from '#worker/newsletter/services.ts'
import { newsletterSignupState } from '#worker/newsletter/signup-state.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'

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

export const newsletterConfirmTokenExpiryMs = 7 * 24 * 60 * 60 * 1000

const confirmGuard = sqlSourcesOf(newsletterSignupState, 'CONFIRM')

const emailPattern = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/

export class InvalidNewsletterEmail extends Schema.TaggedError<InvalidNewsletterEmail>()(
	'InvalidNewsletterEmail',
	{},
) {}

export class NewsletterSignupRateLimited extends Schema.TaggedError<NewsletterSignupRateLimited>()(
	'NewsletterSignupRateLimited',
	{ retryAfterSeconds: Schema.NullOr(Schema.Int) },
) {}

export class NewsletterEmailUnconfigured extends Schema.TaggedError<NewsletterEmailUnconfigured>()(
	'NewsletterEmailUnconfigured',
	{},
) {}

export class InvalidConfirmLink extends Schema.TaggedError<InvalidConfirmLink>()(
	'InvalidConfirmLink',
	{},
) {}

/** The form body at the route boundary: every field a string, extras allowed. */
export const NewsletterForm = Schema.Record(Schema.String, Schema.String)
export type NewsletterForm = typeof NewsletterForm.Type

const ConfirmToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const isConfirmToken = Schema.is(ConfirmToken)

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

const FoundRow = Schema.Struct({ found: Schema.Literal(1) })
const ConfirmedRow = Schema.Struct({
	email: Schema.String,
	stable_id: Schema.String,
})
const AccountRow = Schema.Struct({ stable_user_id: Schema.String })

/**
 * Handle a public sign-up request. Nothing joins the newsletter list here:
 * the address only gets a confirmation link. Success looks the same whether
 * the address is new, pending, already subscribed, throttled per address, or
 * refused by the mailer, so the form cannot reveal who is subscribed.
 */
export const requestNewsletterSignup = Effect.fn('Newsletter.requestSignup')(
	function* (input: { request: Request; form: NewsletterForm }) {
		const d1 = yield* D1
		const limiter = yield* RateLimiter
		const protection = yield* PublicFormProtection
		const mailer = yield* NewsletterMailer
		const auditLog = yield* AuditLog
		const ip = getRequestIp(input.request) ?? undefined
		const audit = (
			result: AuditEvent['result'],
			reason: string,
			email?: string,
		) =>
			auditLog.record({
				category: 'account',
				action: 'newsletter_signup_request',
				result,
				ip,
				path: '/newsletter',
				reason,
				email,
			})

		// Bots that fill every field get the normal success page and no email.
		if (input.form[honeypotFieldName]?.trim()) {
			return yield* audit('failure', 'honeypot')
		}

		const ipLimit = yield* limiter.check(
			`newsletter-signup:ip:${ip ?? 'unknown'}`,
			newsletterSignupIpRateLimit,
		)
		if (!ipLimit.allowed) {
			yield* audit('rate_limited', 'ip')
			return yield* new NewsletterSignupRateLimited({
				retryAfterSeconds: ipLimit.retryAfterSeconds,
			})
		}

		// Human verification comes before any row or email exists.
		yield* protection
			.verify({ request: input.request, form: input.form })
			.pipe(
				Effect.tapError((error) =>
					audit(
						'failure',
						error._tag === 'HumanVerificationUnavailable'
							? 'turnstile_unconfigured'
							: 'turnstile',
					),
				),
			)

		// The sender's own address check has the last word: an address it would
		// refuse must fail here, not report a link that is never sent.
		const email = normalizeEmail(input.form.email ?? '')
		if (
			!email ||
			email.length > 254 ||
			!emailPattern.test(email) ||
			!normalizeAddrSpec(email)
		) {
			yield* audit('failure', 'invalid_email')
			return yield* new InvalidNewsletterEmail()
		}
		yield* Effect.annotateCurrentSpan(
			'newsletter.email_hash',
			yield* sha256Hex(email),
		)

		const subscribed = yield* d1.first(
			'newsletter.already_subscribed',
			FoundRow,
			sql(
				`SELECT 1 AS found FROM newsletter_signups WHERE email = ? AND status = 'confirmed'
				 UNION ALL
				 SELECT 1 AS found FROM users
				 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL
					AND email_verified_at IS NOT NULL AND whats_new_email_opt_in = 1
				 LIMIT 1`,
				email,
				email,
			),
		)
		if (Option.isSome(subscribed)) {
			return yield* audit('success', 'already_subscribed', email)
		}

		const emailLimit = yield* limiter.check(
			`newsletter-signup:email:${yield* sha256Hex(email)}`,
			newsletterSignupEmailRateLimit,
		)
		if (!emailLimit.allowed) {
			return yield* audit('rate_limited', 'email', email)
		}

		const appBaseUrl = mailer.appBaseUrl(input.request)
		if (Option.isNone(appBaseUrl)) {
			yield* audit('failure', 'email_unconfigured', email)
			return yield* new NewsletterEmailUnconfigured()
		}

		const now = yield* DateTime.now
		const nowIso = DateTime.formatIso(now)
		const token = yield* randomHex(32)
		yield* d1.run(
			'newsletter.upsert_pending',
			sql(
				`INSERT INTO newsletter_signups (stable_id, email, token_hash, token_expires_at, requested_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(email) DO UPDATE SET
					token_hash = excluded.token_hash,
					token_expires_at = excluded.token_expires_at,
					requested_at = excluded.requested_at,
					updated_at = excluded.updated_at`,
				yield* randomHex(32),
				email,
				yield* sha256Hex(token),
				DateTime.toEpochMillis(now) + newsletterConfirmTokenExpiryMs,
				nowIso,
				nowIso,
			),
		)

		const confirmUrl = new URL('/newsletter/confirm', appBaseUrl.value)
		confirmUrl.searchParams.set('token', token)
		const message = buildNewsletterConfirmEmail({
			appBaseUrl: appBaseUrl.value,
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
				Effect.andThen(audit('success', 'confirmation_sent', email)),
				// A suppressed or rejected recipient looks like any other request,
				// so the form does not reveal delivery state. Outages are logged.
				Effect.catchTag('ConfirmationEmailFailed', (error) =>
					Effect.logWarning('newsletter-signup-confirm-email-failed', {
						reason: error.reason,
						message:
							error.cause instanceof Error
								? error.cause.message.replaceAll(email, '[email]')
								: '',
					}).pipe(Effect.andThen(audit('failure', 'send_failed', email))),
				),
			)
	},
)

/**
 * Confirm a sign-up from its emailed link. This is the only step that adds
 * an address to the newsletter list. Tokens are single use.
 */
export const confirmNewsletterSignup = Effect.fn('Newsletter.confirmSignup')(
	function* (input: { request: Request; token: string | undefined }) {
		const d1 = yield* D1
		const auditLog = yield* AuditLog
		const ip = getRequestIp(input.request) ?? undefined
		const now = yield* DateTime.now
		const nowIso = DateTime.formatIso(now)
		const token = input.token?.trim() ?? ''
		const confirmed = isConfirmToken(token)
			? yield* d1.first(
					'newsletter.confirm',
					ConfirmedRow,
					sql(
						`UPDATE newsletter_signups
						 SET status = 'confirmed', source = 'newsletter_page', confirmed_at = ?, updated_at = ?, token_hash = NULL, token_expires_at = NULL
						 WHERE token_hash = ? AND token_expires_at > ? AND status IN ${confirmGuard}
						 RETURNING email, stable_id`,
						nowIso,
						nowIso,
						yield* sha256Hex(token),
						DateTime.toEpochMillis(now),
					),
				)
			: Option.none()
		if (Option.isNone(confirmed)) {
			yield* auditLog.record({
				category: 'account',
				action: 'newsletter_signup_confirm',
				result: 'failure',
				ip,
				path: '/newsletter/confirm',
				reason: 'invalid_link',
			})
			return yield* new InvalidConfirmLink()
		}
		const row = confirmed.value

		// An address that already has a verified account keeps its consent on
		// the account, which is what account settings and exports read.
		const account = yield* d1.first(
			'newsletter.confirm_account_opt_in',
			AccountRow,
			sql(
				`UPDATE users SET whats_new_email_opt_in = 1, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = 'email_link'
				 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL AND email_verified_at IS NOT NULL
				 RETURNING stable_user_id`,
				nowIso,
				row.email,
			),
		)
		const stableUserId = Option.match(account, {
			onNone: () => row.stable_id,
			onSome: (found) => found.stable_user_id,
		})

		// The address is confirmed; telling subscribers never fails the confirm.
		yield* recordConsentChange({
			stableUserId,
			optedIn: true,
			source: 'newsletter_page',
			occurredAt: nowIso,
		}).pipe(
			Effect.catch((error) =>
				Effect.logError('whats-new-consent-outbox-record-failed', {
					stableUserId,
					error,
				}),
			),
		)
		yield* auditLog.record({
			category: 'account',
			action: 'newsletter_signup_confirm',
			result: 'success',
			ip,
			path: '/newsletter/confirm',
			email: row.email,
		})
	},
)
