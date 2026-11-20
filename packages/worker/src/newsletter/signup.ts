import { Effect } from 'effect'
import { toHex } from '@kody-internal/shared/hex.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { renderTransactionalEmail } from '#app/email/template.ts'
import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { normalizeAddrSpec } from '#worker/email/address.ts'
import { recordConsentChange } from '#worker/newsletter/consent-outbox.ts'
import { newsletterSignupState } from '#worker/newsletter/signup-state.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import type { RateLimitConfig } from '#worker/rate-limit.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import {
	type DatabaseError,
	EmailUnconfigured,
	InvalidEmail,
	InvalidLink,
	IpRateLimited,
	type VerificationFailed,
	type VerificationUnavailable,
} from './errors.ts'
import {
	AuditLog,
	ConfirmationMailer,
	HumanVerification,
	NewsletterDb,
	RateLimiter,
	type NewsletterEnv,
} from './services.ts'
import { signupLayer } from './signup-layer.ts'

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

export type NewsletterSignupResult =
	| { ok: true }
	| {
			ok: false
			error:
				| 'invalid_email'
				| 'rate_limited'
				| 'unavailable'
				| 'verification_failed'
	  }

export type NewsletterConfirmResult =
	| { ok: true }
	| { ok: false; error: 'invalid_link' }

type WaitUntil = (promise: Promise<unknown>) => void

const randomHex = (bytes: number) =>
	Effect.sync(() => toHex(crypto.getRandomValues(new Uint8Array(bytes))))

const hashToken = (token: string) =>
	Effect.promise(() =>
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
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

/** Every way a sign-up request ends without a typed failure. */
type SignupAccepted =
	| { reason: 'honeypot' }
	| { reason: 'already_subscribed'; email: string }
	| { reason: 'email_rate_limited'; email: string }
	| { reason: 'send_failed'; email: string }
	| { reason: 'confirmation_sent'; email: string }

type SignupRejected =
	| InvalidEmail
	| IpRateLimited
	| VerificationFailed
	| VerificationUnavailable
	| EmailUnconfigured

function signupAuditEntry(
	outcome: SignupAccepted | SignupRejected,
): [
	result: 'success' | 'failure' | 'rate_limited',
	reason: string,
	email?: string,
] {
	if ('_tag' in outcome) {
		switch (outcome._tag) {
			case 'InvalidEmail':
				return ['failure', 'invalid_email']
			case 'IpRateLimited':
				return ['rate_limited', 'ip']
			case 'VerificationFailed':
				return ['failure', 'turnstile']
			case 'VerificationUnavailable':
				return ['failure', 'turnstile_unconfigured']
			case 'EmailUnconfigured':
				return ['failure', 'email_unconfigured', outcome.email]
		}
	}
	switch (outcome.reason) {
		case 'honeypot':
			return ['failure', 'honeypot']
		case 'email_rate_limited':
			return ['rate_limited', 'email', outcome.email]
		case 'send_failed':
			return ['failure', 'send_failed', outcome.email]
		case 'already_subscribed':
		case 'confirmation_sent':
			return ['success', outcome.reason, outcome.email]
	}
}

/**
 * Handle a public sign-up request. Nothing joins the newsletter list here: the
 * address only gets a confirmation link. The result is the same whether the
 * address is new, pending, already subscribed, or throttled per address, so the
 * form cannot be used to learn who is subscribed.
 */
export const newsletterSignup = Effect.fn('newsletterSignup')(
	function* (input: {
		request: Request
		form: Record<string, unknown>
		now: Date
	}): Effect.fn.Return<
		SignupAccepted,
		SignupRejected | DatabaseError,
		| NewsletterDb
		| RateLimiter
		| HumanVerification
		| ConfirmationMailer
		| AuditLog
	> {
		const db = yield* NewsletterDb
		const limiter = yield* RateLimiter
		const ip = getRequestIp(input.request) ?? 'unknown'

		// Bots that fill every field get the normal success page and no email.
		const trap = input.form[honeypotFieldName]
		if (typeof trap === 'string' && trap.trim()) return { reason: 'honeypot' }

		if (
			!(yield* limiter.allow(
				`newsletter-signup:ip:${ip}`,
				newsletterSignupIpRateLimit,
			))
		) {
			return yield* new IpRateLimited()
		}

		// Human verification comes before any row or email exists, so a failed
		// or missing Turnstile token never produces a confirmation email.
		yield* (yield* HumanVerification).verify(input)

		const rawEmail = input.form.email
		const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : ''
		// The sender's own address check has the last word: an address it would
		// refuse must fail here, not report a link that is never sent.
		if (
			!email ||
			email.length > 254 ||
			!emailPattern.test(email) ||
			!normalizeAddrSpec(email)
		) {
			return yield* new InvalidEmail()
		}

		const subscribed = yield* db.first<{ found: number }>(
			`SELECT 1 AS found FROM newsletter_signups WHERE email = ? AND status = 'confirmed'
			 UNION ALL
			 SELECT 1 AS found FROM users
			 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL
				AND email_verified_at IS NOT NULL AND whats_new_email_opt_in = 1
			 LIMIT 1`,
			email,
			email,
		)
		if (subscribed) return { reason: 'already_subscribed', email }

		if (
			!(yield* limiter.allow(
				`newsletter-signup:email:${yield* hashToken(email)}`,
				newsletterSignupEmailRateLimit,
			))
		) {
			return { reason: 'email_rate_limited', email }
		}

		const mailer = yield* ConfirmationMailer
		const appBaseUrl = yield* mailer
			.appBaseUrl(input.request)
			.pipe(Effect.mapError(() => new EmailUnconfigured({ email })))

		const token = yield* randomHex(32)
		const nowIso = input.now.toISOString()
		yield* db.run(
			`INSERT INTO newsletter_signups (stable_id, email, token_hash, token_expires_at, requested_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
				token_hash = excluded.token_hash,
				token_expires_at = excluded.token_expires_at,
				requested_at = excluded.requested_at,
				updated_at = excluded.updated_at`,
			yield* randomHex(32),
			email,
			yield* hashToken(token),
			input.now.getTime() + newsletterConfirmTokenExpiryMs,
			nowIso,
			nowIso,
		)

		const confirmUrl = new URL('/newsletter/confirm', appBaseUrl)
		confirmUrl.searchParams.set('token', token)
		const message = buildNewsletterConfirmEmail({
			appBaseUrl,
			confirmUrl: confirmUrl.toString(),
		})
		return yield* mailer
			.send({
				to: email,
				subject: message.subject,
				html: message.html,
				text: message.text,
				now: input.now,
			})
			.pipe(
				Effect.as<SignupAccepted>({ reason: 'confirmation_sent', email }),
				// A suppressed or rejected recipient looks like any other request,
				// so the form does not reveal delivery state. Outages are reported.
				Effect.catchTag('ConfirmationSendFailed', (failure) =>
					Effect.sync((): SignupAccepted => {
						console.warn(
							'newsletter-signup-confirm-email-failed',
							failure.cause instanceof Error
								? failure.cause.message.replaceAll(email, '[email]')
								: '',
						)
						return { reason: 'send_failed', email }
					}),
				),
			)
	},
	// One audit row per request, whichever way it ended. Database errors are
	// not audited; they reach the caller as failures.
	(effect, input) =>
		Effect.gen(function* () {
			const audit = yield* AuditLog
			const record = (outcome: SignupAccepted | SignupRejected) => {
				const [result, reason, email] = signupAuditEntry(outcome)
				return audit.record({
					category: 'account',
					action: 'newsletter_signup_request',
					result,
					ip: getRequestIp(input.request) ?? undefined,
					path: '/newsletter',
					reason,
					email,
				})
			}
			return yield* effect.pipe(
				Effect.tap(record),
				Effect.tapError((error) =>
					error._tag === 'DatabaseError' ? Effect.void : record(error),
				),
			)
		}),
)

/**
 * Confirm a sign-up from its emailed link. This is the only step that adds an
 * address to the newsletter list. Tokens are single use.
 */
export const confirmSignup = Effect.fn('confirmSignup')(function* (input: {
	request: Request
	token: string | null
	now: Date
}) {
	const db = yield* NewsletterDb
	const audit = yield* AuditLog
	const nowIso = input.now.toISOString()
	const ip = getRequestIp(input.request) ?? undefined
	const token = input.token?.trim() ?? ''
	const row = /^[a-f0-9]{64}$/.test(token)
		? yield* db.first<{ email: string; stable_id: string }>(
				`UPDATE newsletter_signups
				 SET status = 'confirmed', source = 'newsletter_page', confirmed_at = ?, updated_at = ?, token_hash = NULL, token_expires_at = NULL
				 WHERE token_hash = ? AND token_expires_at > ? AND status IN ${confirmGuard}
				 RETURNING email, stable_id`,
				nowIso,
				nowIso,
				yield* hashToken(token),
				input.now.getTime(),
			)
		: null
	if (!row) {
		yield* audit.record({
			category: 'account',
			action: 'newsletter_signup_confirm',
			result: 'failure',
			ip,
			path: '/newsletter/confirm',
			reason: 'invalid_link',
		})
		return yield* new InvalidLink()
	}
	// An address that already has a verified account keeps its consent on the
	// account, which is what account settings and exports read.
	const account = yield* db.first<{ stable_user_id: string }>(
		`UPDATE users SET whats_new_email_opt_in = 1, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = 'email_link'
		 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL AND email_verified_at IS NOT NULL
		 RETURNING stable_user_id`,
		nowIso,
		row.email,
	)
	// The page already confirmed; telling subscribers never fails the confirm.
	// The type says so: recordConsentChange has `never` in its error channel.
	yield* recordConsentChange({
		stableUserId: account?.stable_user_id ?? row.stable_id,
		optedIn: true,
		source: 'newsletter_page',
		occurredAt: nowIso,
		now: input.now,
	})
	yield* audit.record({
		category: 'account',
		action: 'newsletter_signup_confirm',
		result: 'success',
		ip,
		path: '/newsletter/confirm',
		email: row.email,
	})
})

/** Promise boundary for the Start route handler and tests. */
export function requestNewsletterSignup(input: {
	env: NewsletterEnv
	request: Request
	form: Record<string, unknown>
	now?: Date
	waitUntil?: WaitUntil
}): Promise<NewsletterSignupResult> {
	return newsletterSignup({
		request: input.request,
		form: input.form,
		now: input.now ?? new Date(),
	}).pipe(
		Effect.as<NewsletterSignupResult>({ ok: true }),
		Effect.catchTags({
			InvalidEmail: () => fail('invalid_email'),
			IpRateLimited: () => fail('rate_limited'),
			VerificationFailed: () => fail('verification_failed'),
			VerificationUnavailable: () => fail('unavailable'),
			EmailUnconfigured: () => fail('unavailable'),
		}),
		Effect.provide(signupLayer(input.env, { waitUntil: input.waitUntil })),
		Effect.runPromise,
	)
}

const fail = (error: Extract<NewsletterSignupResult, { ok: false }>['error']) =>
	Effect.succeed<NewsletterSignupResult>({ ok: false, error })

/** Promise boundary for the Start route handler and tests. */
export function confirmNewsletterSignup(input: {
	env: NewsletterEnv
	request: Request
	token: string | null
	now?: Date
	waitUntil?: WaitUntil
}): Promise<NewsletterConfirmResult> {
	return confirmSignup({
		request: input.request,
		token: input.token,
		now: input.now ?? new Date(),
	}).pipe(
		Effect.as<NewsletterConfirmResult>({ ok: true }),
		Effect.catchTag('InvalidLink', () =>
			Effect.succeed<NewsletterConfirmResult>({
				ok: false,
				error: 'invalid_link',
			}),
		),
		Effect.provide(signupLayer(input.env, { waitUntil: input.waitUntil })),
		Effect.runPromise,
	)
}
