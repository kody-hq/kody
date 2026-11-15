import { toHex } from '@kody-internal/shared/hex.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { renderTransactionalEmail } from '#app/email/template.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { sendNewsletterConfirmationEmail } from '#worker/email/system-outbound.ts'
import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { normalizeAddrSpec } from '#worker/email/address.ts'
import { newsletterSignupState } from '#worker/newsletter/signup-state.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
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

export type NewsletterSignupResult =
	| { ok: true }
	| { ok: false; error: 'invalid_email' | 'rate_limited' | 'unavailable' }

type SignupEnv = Parameters<typeof sendNewsletterConfirmationEmail>[0]['env'] &
	Parameters<typeof resolveTransactionalEmailConfig>[0]['env'] &
	Parameters<typeof auditDatabaseFromEnv>[0]

function randomHex(bytes: number) {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function hashToken(token: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token),
	)
	return toHex(new Uint8Array(digest))
}

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
export async function requestNewsletterSignup(input: {
	env: SignupEnv
	request: Request
	form: Record<string, unknown>
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<NewsletterSignupResult> {
	const { env, request } = input
	const db = env.APP_DB
	const ip = getRequestIp(request) ?? undefined
	const audit = (
		result: 'success' | 'failure' | 'rate_limited',
		reason: string,
		email?: string,
	) =>
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'newsletter_signup_request',
			result,
			ip,
			path: '/newsletter',
			reason,
			email,
		})

	// Bots that fill every field get the normal success page and no email.
	const trap = input.form[honeypotFieldName]
	if (typeof trap === 'string' && trap.trim()) {
		audit('failure', 'honeypot')
		return { ok: true }
	}

	const ipLimit = await checkRateLimit(
		db,
		`newsletter-signup:ip:${ip ?? 'unknown'}`,
		newsletterSignupIpRateLimit,
	)
	if (!ipLimit.allowed) {
		audit('rate_limited', 'ip')
		return { ok: false, error: 'rate_limited' }
	}

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
		audit('failure', 'invalid_email')
		return { ok: false, error: 'invalid_email' }
	}

	const subscribed = await db
		.prepare(
			`SELECT 1 AS found FROM newsletter_signups WHERE email = ? AND status = 'confirmed'
			 UNION ALL
			 SELECT 1 AS found FROM users
			 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL
				AND email_verified_at IS NOT NULL AND whats_new_email_opt_in = 1
			 LIMIT 1`,
		)
		.bind(email, email)
		.first<{ found: number }>()
	if (subscribed) {
		audit('success', 'already_subscribed', email)
		return { ok: true }
	}

	const emailLimit = await checkRateLimit(
		db,
		`newsletter-signup:email:${await hashToken(email)}`,
		newsletterSignupEmailRateLimit,
	)
	if (!emailLimit.allowed) {
		audit('rate_limited', 'email', email)
		return { ok: true }
	}

	const config = resolveTransactionalEmailConfig({
		env,
		requestUrl: env.WRANGLER_IS_LOCAL_DEV === 'true' ? request.url : undefined,
	})
	if (!config) {
		audit('failure', 'email_unconfigured', email)
		return { ok: false, error: 'unavailable' }
	}

	const now = input.now ?? new Date()
	const token = randomHex(32)
	const nowIso = now.toISOString()
	await db
		.prepare(
			`INSERT INTO newsletter_signups (stable_id, email, token_hash, token_expires_at, requested_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
				token_hash = excluded.token_hash,
				token_expires_at = excluded.token_expires_at,
				requested_at = excluded.requested_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			randomHex(32),
			email,
			await hashToken(token),
			now.getTime() + newsletterConfirmTokenExpiryMs,
			nowIso,
			nowIso,
		)
		.run()

	const confirmUrl = new URL('/newsletter/confirm', config.appBaseUrl)
	confirmUrl.searchParams.set('token', token)
	const message = buildNewsletterConfirmEmail({
		appBaseUrl: config.appBaseUrl,
		confirmUrl: confirmUrl.toString(),
	})
	try {
		await sendNewsletterConfirmationEmail({
			env,
			to: email,
			subject: message.subject,
			html: message.html,
			text: message.text,
			now,
			waitUntil: input.waitUntil,
		})
	} catch (error) {
		// A suppressed or rejected recipient looks like any other request, so
		// the form does not reveal delivery state. Outages are reported.
		console.warn(
			'newsletter-signup-confirm-email-failed',
			error instanceof Error ? error.message.replaceAll(email, '[email]') : '',
		)
		audit('failure', 'send_failed', email)
		return { ok: true }
	}
	audit('success', 'confirmation_sent', email)
	return { ok: true }
}

export type NewsletterConfirmResult =
	| { ok: true }
	| { ok: false; error: 'invalid_link' }

/**
 * Confirm a sign-up from its emailed link. This is the only step that adds an
 * address to the newsletter list. Tokens are single use.
 */
export async function confirmNewsletterSignup(input: {
	env: Pick<SignupEnv, 'APP_DB'> & Parameters<typeof auditDatabaseFromEnv>[0]
	request: Request
	token: string | null
	now?: Date
}): Promise<NewsletterConfirmResult> {
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const ip = getRequestIp(input.request) ?? undefined
	const token = input.token?.trim() ?? ''
	const row = /^[a-f0-9]{64}$/.test(token)
		? await db
				.prepare(
					`UPDATE newsletter_signups
					 SET status = 'confirmed', source = 'newsletter_page', confirmed_at = ?, updated_at = ?, token_hash = NULL, token_expires_at = NULL
					 WHERE token_hash = ? AND token_expires_at > ? AND status IN ${confirmGuard}
					 RETURNING email`,
				)
				.bind(nowIso, nowIso, await hashToken(token), now.getTime())
				.first<{ email: string }>()
		: null
	if (!row) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'account',
			action: 'newsletter_signup_confirm',
			result: 'failure',
			ip,
			path: '/newsletter/confirm',
			reason: 'invalid_link',
		})
		return { ok: false, error: 'invalid_link' }
	}
	// An address that already has a verified account keeps its consent on the
	// account, which is what account settings and exports read.
	await db
		.prepare(
			`UPDATE users SET whats_new_email_opt_in = 1, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = 'email_link'
			 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL AND email_verified_at IS NOT NULL`,
		)
		.bind(nowIso, row.email)
		.run()
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'account',
		action: 'newsletter_signup_confirm',
		result: 'success',
		ip,
		path: '/newsletter/confirm',
		email: row.email,
	})
	return { ok: true }
}
