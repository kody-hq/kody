/**
 * Rolling cap on verification emails to one recipient, across signups,
 * resends, and any other `createEmailVerification` caller. The counter key
 * in `_rate_limits` is a hash of the normalized address because that table
 * stores keys in the clear.
 */

import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { parseAccountEmail } from '#worker/identity/account-email-policy.ts'
import {
	loadVerificationRecipientHardBounce,
	verificationHardBounceMessage,
} from '#worker/email/verification-recipient-suppression.ts'

export const verificationEmailCapMax = 5
const verificationEmailCapWindowSeconds = 24 * 60 * 60

const capKeyPrefix = 'verify-email:recipient:'

export const malformedAccountEmailSendMessage =
	"This account's email address is not valid, so we cannot send a verification email. Contact support@kody.codes and we can verify the account another way."

export type VerificationEmailSendBlock = {
	ok: false
	code: 'invalid_email' | 'recipient_hard_bounce' | 'verification_email_cap'
	error: string
	status: 400 | 409 | 429
	retryAfterSeconds: number | null
}

export type VerificationEmailReservation =
	| { ok: true; consumed: boolean; email: string }
	| VerificationEmailSendBlock

export class VerificationEmailRefusedError extends Error {
	readonly code: VerificationEmailSendBlock['code']
	readonly status: VerificationEmailSendBlock['status']
	readonly retryAfterSeconds: number | null

	constructor(block: VerificationEmailSendBlock) {
		super(block.error)
		this.name = 'VerificationEmailRefusedError'
		this.code = block.code
		this.status = block.status
		this.retryAfterSeconds = block.retryAfterSeconds
	}
}

function finiteNumber(value: unknown) {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return parsed
	}
	return null
}

function isIncompleteRateLimitStore(error: unknown) {
	if (error instanceof TypeError) return true
	const message = error instanceof Error ? error.message : String(error)
	return /no such table/i.test(message) || /is not a function/i.test(message)
}

function isInfrastructureError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		error instanceof TypeError ||
		/no such table/i.test(message) ||
		/SQLITE_ERROR/i.test(message) ||
		/\.run is not a function/i.test(message) ||
		/\.batch is not a function/i.test(message) ||
		/\.first is not a function/i.test(message)
	)
}

async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export async function verificationEmailCapKey(email: string) {
	const parsed = parseAccountEmail(email)
	const normalized = parsed?.email ?? email.trim().toLowerCase()
	return `${capKeyPrefix}${await sha256Hex(normalized)}`
}

function formatVerificationRetry(retryAfterSeconds: number) {
	const seconds = Math.max(1, Math.ceil(retryAfterSeconds))
	if (seconds < 90) return '1 minute'
	if (seconds < 60 * 60) {
		const minutes = Math.ceil(seconds / 60)
		return `${String(minutes)} minutes`
	}
	const hours = Math.ceil(seconds / (60 * 60))
	return hours === 1 ? '1 hour' : `${String(hours)} hours`
}

export function verificationEmailCapMessage(
	retryAfterSeconds: number,
	now = new Date(),
) {
	const seconds = Math.max(1, Math.ceil(retryAfterSeconds))
	const retryAt = new Date(now.getTime() + seconds * 1000).toISOString()
	return `This address has already received ${String(verificationEmailCapMax)} verification emails in the last 24 hours. Try again in ${formatVerificationRetry(seconds)} (after ${retryAt}), or use a different address.`
}

function capBlock(
	retryAfterSeconds: number,
	now?: Date,
): VerificationEmailSendBlock {
	return {
		ok: false,
		code: 'verification_email_cap',
		error: verificationEmailCapMessage(retryAfterSeconds, now),
		status: 429,
		retryAfterSeconds,
	}
}

async function retryAfterForKey(
	db: D1Database,
	key: string,
	nowSeconds: number,
) {
	try {
		const row = await db
			.prepare(
				`SELECT MIN(ts) AS oldest
				 FROM _rate_limits
				 WHERE key = ? AND ts > ?`,
			)
			.bind(key, nowSeconds - verificationEmailCapWindowSeconds)
			.first<{ oldest: number | null }>()
		const oldest = finiteNumber(row?.oldest)
		if (oldest == null) return verificationEmailCapWindowSeconds
		return Math.max(1, oldest + verificationEmailCapWindowSeconds - nowSeconds)
	} catch (error) {
		if (isInfrastructureError(error)) return verificationEmailCapWindowSeconds
		throw error
	}
}

/**
 * Same table `checkRateLimit` creates. Peek runs before that insert, so the
 * first signup of a process has to create it or the count query fails open.
 */
async function ensureVerificationEmailCapTable(db: D1Database) {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS _rate_limits (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL,
				ts INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON _rate_limits (key, ts)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_rate_limits_ts ON _rate_limits (ts)`,
		),
	])
}

/**
 * Read the cap without consuming a slot. A missing counter (test doubles,
 * table not created yet) allows the send; `reserveVerificationEmailSend`
 * is the authoritative consume.
 */
export async function peekVerificationEmailCap(input: {
	db: D1Database
	email: string
	now?: Date
}): Promise<VerificationEmailSendBlock | { ok: true }> {
	const now = input.now ?? new Date()
	const nowSeconds = Math.floor(now.getTime() / 1000)
	const key = await verificationEmailCapKey(input.email)
	try {
		await ensureVerificationEmailCapTable(input.db)
		const row = await input.db
			.prepare(
				`SELECT COUNT(*) AS count, MIN(ts) AS oldest
				 FROM _rate_limits
				 WHERE key = ? AND ts > ?`,
			)
			.bind(key, nowSeconds - verificationEmailCapWindowSeconds)
			.first<{
				count: number | string | null
				oldest: number | string | null
			}>()
		const count = finiteNumber(row?.count)
		if (count == null) return { ok: true }
		if (count < verificationEmailCapMax) return { ok: true }
		const oldest = finiteNumber(row?.oldest)
		const retryAfterSeconds =
			oldest == null
				? verificationEmailCapWindowSeconds
				: Math.max(1, oldest + verificationEmailCapWindowSeconds - nowSeconds)
		return capBlock(retryAfterSeconds, now)
	} catch (error) {
		if (isIncompleteRateLimitStore(error)) return { ok: true }
		if (isInfrastructureError(error)) {
			console.warn('verification-email-cap-peek-failed', error)
			return { ok: true }
		}
		throw error
	}
}

async function readVerificationSendBlock(input: {
	db: D1Database
	email: string
	now?: Date
}): Promise<VerificationEmailSendBlock | { ok: true; email: string }> {
	const parsed = parseAccountEmail(input.email)
	if (!parsed) {
		return {
			ok: false,
			code: 'invalid_email',
			error: malformedAccountEmailSendMessage,
			status: 400,
			retryAfterSeconds: null,
		}
	}
	const bounce = await loadVerificationRecipientHardBounce({
		db: input.db,
		recipient: parsed.email,
	})
	if (bounce) {
		return {
			ok: false,
			code: 'recipient_hard_bounce',
			error: verificationHardBounceMessage,
			status: 409,
			retryAfterSeconds: null,
		}
	}
	const cap = await peekVerificationEmailCap({
		db: input.db,
		email: parsed.email,
		now: input.now,
	})
	if (!cap.ok) return cap
	return { ok: true, email: parsed.email }
}

/** Suppression and cap check that does not consume a slot. */
export async function inspectVerificationEmailSend(input: {
	db: D1Database
	email: string
	now?: Date
}): Promise<VerificationEmailSendBlock | { ok: true; email: string }> {
	return readVerificationSendBlock(input)
}

/**
 * Consume one verification-email slot after suppression and the cap peek
 * pass. Callers release the slot when the provider send does not happen.
 */
export async function reserveVerificationEmailSend(input: {
	db: D1Database
	email: string
	now?: Date
}): Promise<VerificationEmailReservation> {
	const blocked = await readVerificationSendBlock(input)
	if (!blocked.ok) return blocked
	const now = input.now ?? new Date()
	const key = await verificationEmailCapKey(blocked.email)
	try {
		const result = await checkRateLimit(input.db, key, {
			maxRequests: verificationEmailCapMax,
			windowSeconds: verificationEmailCapWindowSeconds,
		})
		if (!result.allowed) {
			const retryAfterSeconds = await retryAfterForKey(
				input.db,
				key,
				Math.floor(now.getTime() / 1000),
			)
			return capBlock(retryAfterSeconds, now)
		}
		return { ok: true, consumed: true, email: blocked.email }
	} catch (error) {
		if (isIncompleteRateLimitStore(error)) {
			return { ok: true, consumed: false, email: blocked.email }
		}
		if (isInfrastructureError(error)) {
			console.warn('verification-email-cap-reserve-failed', error)
			return { ok: true, consumed: false, email: blocked.email }
		}
		throw error
	}
}

export async function releaseVerificationEmailSend(
	db: D1Database,
	email: string,
) {
	const key = await verificationEmailCapKey(email)
	await releaseRateLimit(db, key)
}
