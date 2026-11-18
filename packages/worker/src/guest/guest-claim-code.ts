import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import {
	readLatestSystemEmailSend,
	type SystemEmailSendRecord,
} from '#worker/email/system-email-sends.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	assertClaimUsernameAvailable,
	convertGuestInPlace,
	findClaimTargetByEmail,
	GuestClaimError,
	mergeGuestIntoAccount,
	readClaimableGuestUser,
	type GuestClaimResult,
} from './guest-claim.ts'
import type { GuestAccount } from './guest-accounts.ts'

export const guestClaimCodeTtlMs = 15 * 60 * 1000
export const guestClaimCodeMaxAttempts = 5

/** Fresh claim codes per guest per hour (each resets the guess counter). */
export const guestClaimStartRateLimit: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 60 * 60,
}

export type GuestClaimCodeErrorCode =
	| 'email_invalid'
	| 'code_missing'
	| 'code_invalid'
	| 'code_expired'
	| 'too_many_attempts'
	| 'send_failed'
	| 'rate_limited'

export const guestClaimCodeEmailKind = 'guest_claim_code'

export class GuestClaimCodeError extends Error {
	readonly code: GuestClaimCodeErrorCode
	/** What Kody knows about delivery of the latest code email, when relevant. */
	readonly deliveryNote: string | null
	constructor(
		code: GuestClaimCodeErrorCode,
		message: string,
		options: { deliveryNote?: string | null } = {},
	) {
		super(message)
		this.name = 'GuestClaimCodeError'
		this.code = code
		this.deliveryNote = options.deliveryNote ?? null
	}
}

const failedDeliveryStatuses = new Set([
	'bounced',
	'failed',
	'rejected',
	'complained',
])

/** One sentence on the latest claim code email, from Cloudflare's reports. */
export function describeClaimCodeDelivery(
	send: SystemEmailSendRecord | null,
): string {
	if (!send) {
		return 'Kody has no record that its mail provider accepted the code email.'
	}
	const id = send.providerMessageId
	const status = send.deliveryStatus
	if (!status) {
		return `Kody's mail provider accepted the code email (message ${id}) but has not confirmed delivery yet.`
	}
	if (status === 'delivered') {
		return `Kody's mail provider reports the code email (message ${id}) was delivered to the recipient's mail server; if it is not in the inbox, it may be in spam or held by a filter.`
	}
	if (status === 'deferred') {
		return `Delivery of the code email (message ${id}) is delayed; the mail provider is still retrying.`
	}
	if (failedDeliveryStatuses.has(status)) {
		return `The code email (message ${id}) was not delivered (${status}).`
	}
	return `The latest delivery report for the code email (message ${id}) is ${status}.`
}

async function latestClaimCodeDeliveryNote(db: D1Database, email: string) {
	return describeClaimCodeDelivery(
		await readLatestSystemEmailSend({
			db,
			recipient: email,
			kind: guestClaimCodeEmailKind,
		}),
	)
}

type ClaimCodeRow = {
	person_id: string
	email: string
	username: string | null
	mode: 'new' | 'merge'
	code_hash: string
	attempts: number
	expires_at: string
}

async function hashClaimCode(code: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`guest-claim:${code}`),
	)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

function mintSixDigitCode() {
	const value = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000
	return value.toString().padStart(6, '0')
}

function isPlausibleEmail(email: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}

function claimCodeEmail(input: { code: string; appBaseUrl: string }) {
	const subject = `Your Kody claim code: ${input.code}`
	const text = [
		`Your code to claim your Kody guest account is ${input.code}.`,
		'',
		'Read it to your agent to finish claiming. It expires in 15 minutes.',
		'',
		`If you did not ask for this, you can ignore this email. ${input.appBaseUrl}`,
	].join('\n')
	const html = `<p>Your code to claim your Kody guest account is <strong style="font-size:20px;letter-spacing:2px">${input.code}</strong>.</p><p>Read it to your agent to finish claiming. It expires in 15 minutes.</p><p>If you did not ask for this, you can ignore this email.</p>`
	return { subject, text, html }
}

export type GuestClaimStartResult = {
	email: string
	mode: 'new' | 'merge'
	expiresAt: string
	/** Non-production runtimes have no mail sender; the code comes back here. */
	devCode: string | null
	/** Cloudflare Email Sending message id; null when no email went out. */
	providerMessageId: string | null
	/**
	 * `accepted`: the mail provider took the email, inbox delivery is not
	 * confirmed. `dev_code`: non-production send failed or was skipped.
	 */
	codeDelivery: 'accepted' | 'dev_code'
}

/**
 * Agent-led claim, step one: check the request, then email a one-time code
 * the person reads back to their agent.
 */
export async function startGuestClaim(input: {
	env: Env
	guest: GuestAccount
	email: string
	username?: string | null
	merge?: boolean
	requestUrl: string
	now?: Date
}): Promise<GuestClaimStartResult> {
	const { env, guest } = input
	const db = env.APP_DB
	await readClaimableGuestUser(db, guest)
	const email = normalizeEmail(input.email)
	if (!isPlausibleEmail(email)) {
		throw new GuestClaimCodeError(
			'email_invalid',
			'That does not look like an email address.',
		)
	}
	const mode = input.merge ? 'merge' : 'new'
	let username: string | null = null
	if (mode === 'merge') {
		if (!(await findClaimTargetByEmail(db, email))) {
			throw new GuestClaimError(
				'no_account',
				'No Kody account uses that email. Claim into a new account with a username instead.',
			)
		}
	} else {
		if (!input.username?.trim()) {
			throw new GuestClaimError(
				'username_invalid',
				'Pick a username for the new account, or ask to merge into an existing account.',
			)
		}
		if (await findClaimTargetByEmail(db, email)) {
			throw new GuestClaimError(
				'email_taken',
				'That email already has a Kody account. Ask to merge into it instead.',
			)
		}
		username = await assertClaimUsernameAvailable(
			env,
			input.username,
			guest.personId,
		)
	}
	const startLimit = await checkRateLimit(
		db,
		`guest-claim-start:${guest.personId}`,
		guestClaimStartRateLimit,
	)
	if (!startLimit.allowed) {
		throw new GuestClaimCodeError(
			'rate_limited',
			'Too many claim codes were sent for this guest account. Wait an hour, or use the claim link instead.',
		)
	}
	const now = input.now ?? new Date()
	const code = mintSixDigitCode()
	const expiresAt = new Date(now.getTime() + guestClaimCodeTtlMs).toISOString()
	await db
		.prepare(
			`INSERT INTO guest_claim_codes
				(person_id, email, username, mode, code_hash, attempts, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(person_id) DO UPDATE SET
				email = excluded.email, username = excluded.username, mode = excluded.mode,
				code_hash = excluded.code_hash, attempts = 0,
				expires_at = excluded.expires_at, created_at = excluded.created_at`,
		)
		.bind(
			guest.personId,
			email,
			username,
			mode,
			await hashClaimCode(code),
			expiresAt,
			now.toISOString(),
		)
		.run()
	const emailConfig = resolveTransactionalEmailConfig({
		env,
		requestUrl: input.requestUrl,
	}) ?? {
		appBaseUrl: new URL(input.requestUrl).origin,
		fromEmail: `kody@${new URL(input.requestUrl).hostname}`,
	}
	const message = claimCodeEmail({ code, appBaseUrl: emailConfig.appBaseUrl })
	const nonProduction = isNonProductionRuntime(env)
	const sent = await sendGatedTransactionalEmail({
		db,
		config: {
			accountId: env.CLOUDFLARE_ACCOUNT_ID,
			apiBaseUrl: env.CLOUDFLARE_API_BASE_URL,
			apiToken: env.CLOUDFLARE_API_TOKEN,
		},
		category: 'essential',
		kind: guestClaimCodeEmailKind,
		message: {
			to: email,
			from: emailConfig.fromEmail,
			subject: message.subject,
			html: message.html,
			text: message.text,
		},
	}).catch((error: unknown) => {
		console.warn('guest-claim-code-send-threw', {
			error: error instanceof Error ? error.message : String(error),
		})
		return { ok: false as const, error: 'provider_error' }
	})
	const providerMessageId = sent.ok ? (sent.messageId ?? null) : null
	const failure = sent.ok
		? null
		: 'hold' in sent && sent.hold
			? `held:${sent.code}`
			: 'skipped' in sent && sent.skipped
				? 'skipped'
				: 'provider_error'
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'guest_claim_code_sent',
		result: sent.ok ? 'success' : 'failure',
		email,
		reason: sent.ok
			? `mode=${mode};message_id=${providerMessageId ?? 'none'}`
			: `mode=${mode};error=${failure}`,
	})
	if (!sent.ok && !nonProduction) {
		throw new GuestClaimCodeError(
			'send_failed',
			failure?.startsWith('held:')
				? 'Kody is holding email to that address after earlier delivery problems, so no claim code was sent.'
				: 'Kody could not send the claim code email. Try again in a minute.',
		)
	}
	return {
		email,
		mode,
		expiresAt,
		devCode: nonProduction ? code : null,
		providerMessageId,
		codeDelivery: sent.ok ? 'accepted' : 'dev_code',
	}
}

/** Agent-led claim, step two: check the code and finish the claim. */
export async function finishGuestClaim(input: {
	env: Env
	guest: GuestAccount
	code: string
	baseUrl: string
	now?: Date
	/** `email_code` from the claim page, `agent` (default) from guestClaimFinish. */
	method?: 'email_code' | 'agent'
}): Promise<GuestClaimResult> {
	const { env, guest } = input
	const db = env.APP_DB
	const row = await db
		.prepare(`SELECT * FROM guest_claim_codes WHERE person_id = ?`)
		.bind(guest.personId)
		.first<ClaimCodeRow>()
	if (!row) {
		throw new GuestClaimCodeError(
			'code_missing',
			`No claim is in progress. Start one with the person's email first.`,
		)
	}
	const now = input.now ?? new Date()
	if (Date.parse(row.expires_at) <= now.getTime()) {
		throw new GuestClaimCodeError(
			'code_expired',
			'That code expired. Start the claim again to get a new one.',
			{ deliveryNote: await latestClaimCodeDeliveryNote(db, row.email) },
		)
	}
	if (row.attempts >= guestClaimCodeMaxAttempts) {
		throw new GuestClaimCodeError(
			'too_many_attempts',
			'Too many wrong codes. Start the claim again to get a new one.',
			{ deliveryNote: await latestClaimCodeDeliveryNote(db, row.email) },
		)
	}
	const code = input.code.replace(/\D/g, '')
	if (
		!(await timingSafeEqualString(await hashClaimCode(code), row.code_hash))
	) {
		await db
			.prepare(
				`UPDATE guest_claim_codes SET attempts = attempts + 1 WHERE person_id = ?`,
			)
			.bind(guest.personId)
			.run()
		throw new GuestClaimCodeError(
			'code_invalid',
			'That code is not right. Check the email and try again.',
			{ deliveryNote: await latestClaimCodeDeliveryNote(db, row.email) },
		)
	}
	if (row.mode === 'merge') {
		const target = await findClaimTargetByEmail(db, row.email)
		if (!target) {
			throw new GuestClaimError(
				'no_account',
				'No Kody account uses that email anymore.',
			)
		}
		return mergeGuestIntoAccount({
			env,
			guest,
			target,
			baseUrl: input.baseUrl,
			now,
			method: input.method ?? 'agent',
		})
	}
	return convertGuestInPlace({
		env,
		guest,
		email: row.email,
		username: row.username ?? '',
		now,
		method: input.method ?? 'agent',
	})
}
