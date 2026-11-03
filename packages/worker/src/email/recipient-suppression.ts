/**
 * Per-recipient hard-bounce suppression for system mail (`kody@` and the
 * other reserved senders), stored in `email_recipient_suppressions`.
 *
 * Two levels share one row per recipient:
 *
 * - **Verification suppression.** One hard bounce of verification or
 *   password-reset mail stops later verification sends and both
 *   password-reset emails to the address, including from a different
 *   account. Retrying a verification link into a dead mailbox only burns
 *   sender reputation, and the user can pick another address or ask support.
 * - **Full suppression.** `systemEmailHardBounceSuppressionThreshold`
 *   consecutive hard bounces of any recorded system send (onboarding, usage
 *   notices, billing, verification, operator mail) stop all system mail to
 *   the address, verification included.
 *
 * A later `delivered` event to the address deletes the row (the address
 * works again), and so does an admin clear. Below-threshold rows that are not
 * suppressed age out after `recipientSuppressionTrackingRetentionDays`, so
 * "repeated" means hard bounces with no delivery in between and no more than
 * that window apart. Sender-domain blocklist hits stay on the temporary
 * cooldown path and are never recorded here. Mailbox and forwarding events do
 * not write this table.
 */

import { normalizeEmailAddress } from './address.ts'
import { parseAccountEmail } from '#worker/identity/account-email-policy.ts'
import { classifyVerificationDeliveryFailure } from './verification-delivery.ts'
import type { EmailDeliveryStatus } from './types.ts'

export const verificationHardBounceMessage =
	'We stopped sending verification email to this address after a previous message bounced. Use a different address, or contact support@kody.codes so we can verify the account another way.'

export const recipientSuppressedMessage =
	'Email was not sent because this address hard-bounced repeatedly. An admin can clear the suppression once the address accepts mail again.'

export const systemEmailHardBounceSuppressionThreshold = 2
export const recipientSuppressionTrackingRetentionDays = 90

const detailMaxLength = 500

export type HardBounceInput = {
	status: EmailDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	smtpStatusCode?: string | null
}

export type RecipientSuppressionScope = 'all' | 'verification' | 'tracking'

export type RecipientSuppression = {
	recipient: string
	scope: RecipientSuppressionScope
	hardBounceCount: number
	suppressedAt: string | null
	verificationSuppressedAt: string | null
	lastStatus: string
	lastDetail: string | null
	lastHardBounceAt: string
	createdAt: string
	updatedAt: string
}

export function isMissingSuppressionStore(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		error instanceof TypeError ||
		/no such table/i.test(message) ||
		/\.prepare is not a function/i.test(message) ||
		/\.first is not a function/i.test(message) ||
		/\.run is not a function/i.test(message) ||
		/\.all is not a function/i.test(message) ||
		/\.batch is not a function/i.test(message)
	)
}

function permanentSmtpFailure(input: HardBounceInput) {
	const statusCode = input.smtpStatusCode?.trim() ?? ''
	if (/^5\d\d$/u.test(statusCode)) return true
	if (/^4\d\d$/u.test(statusCode)) return false
	const enhanced = input.smtpEnhancedStatusCode?.trim() ?? ''
	if (enhanced.startsWith('5.')) return true
	if (enhanced.startsWith('4.')) return false
	const response = input.smtpResponse ?? ''
	const statusMatch = /\b([45])\d{2}\b/u.exec(response)
	if (statusMatch) return statusMatch[1] === '5'
	const enhancedMatch = /\b([45])\.\d{1,3}\.\d{1,3}\b/u.exec(response)
	if (enhancedMatch) return enhancedMatch[1] === '5'
	return false
}

/**
 * A hard bounce is Cloudflare's `bounced` event, or a `failed` / `rejected`
 * event with a permanent 5xx SMTP code. Blocklist / sender-domain rejections
 * stay on the existing temporary cooldown. Complaints and 4xx deferrals do
 * not suppress the address.
 */
export function isHardBounce(input: HardBounceInput) {
	if (
		input.status !== 'bounced' &&
		input.status !== 'failed' &&
		input.status !== 'rejected'
	) {
		return false
	}
	const deliveryClass = classifyVerificationDeliveryFailure({
		status: input.status,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
	})
	if (deliveryClass === 'sender_block') return false
	if (input.status === 'bounced') return true
	return permanentSmtpFailure(input)
}

/**
 * Account emails allow RFC punctuation such as `'`. Cloudflare events may
 * also wrap the address as `Name <addr>`. Key both shapes the same way
 * `parseAccountEmail` does, so a bounce is not stored under a truncated
 * local part.
 */
export function canonicalSuppressionRecipient(recipient: string) {
	const trimmed = recipient.trim()
	const wrapped = /<([^<>]+)>/u.exec(trimmed)
	const candidate = wrapped?.[1] ?? trimmed
	const parsed = parseAccountEmail(candidate)
	if (parsed) return parsed.email
	return normalizeEmailAddress(trimmed)
}

export function truncateSuppressionDetail(value: string | null | undefined) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.length > detailMaxLength
		? trimmed.slice(0, detailMaxLength)
		: trimmed
}

export function hardBounceDetail(input: HardBounceInput) {
	return truncateSuppressionDetail(
		input.smtpResponse ??
			input.smtpEnhancedStatusCode ??
			input.smtpStatusCode ??
			null,
	)
}

type SuppressionRow = {
	recipient: string
	hard_bounce_count: number
	suppressed_at: string | null
	verification_suppressed_at: string | null
	last_status: string
	last_detail: string | null
	last_hard_bounce_at: string
	created_at: string
	updated_at: string
}

function mapSuppressionRow(row: SuppressionRow): RecipientSuppression {
	return {
		recipient: row.recipient,
		scope: row.suppressed_at
			? 'all'
			: row.verification_suppressed_at
				? 'verification'
				: 'tracking',
		hardBounceCount: Number(row.hard_bounce_count),
		suppressedAt: row.suppressed_at,
		verificationSuppressedAt: row.verification_suppressed_at,
		lastStatus: row.last_status,
		lastDetail: row.last_detail,
		lastHardBounceAt: row.last_hard_bounce_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

/**
 * Current row for the address, including below-threshold tracking rows.
 * Fails open (returns null) when the table is missing.
 */
export async function loadRecipientSuppression(input: {
	db: D1Database
	recipient: string
}): Promise<RecipientSuppression | null> {
	const recipient = canonicalSuppressionRecipient(input.recipient)
	if (!recipient) return null
	try {
		const row = await input.db
			.prepare(`SELECT * FROM email_recipient_suppressions WHERE recipient = ?`)
			.bind(recipient)
			.first<SuppressionRow>()
		return row ? mapSuppressionRow(row) : null
	} catch (error) {
		if (isMissingSuppressionStore(error)) return null
		throw error
	}
}

/** Verification and password-reset mail stop at either suppression level. */
export async function loadVerificationRecipientHardBounce(input: {
	db: D1Database
	recipient: string
}): Promise<RecipientSuppression | null> {
	const suppression = await loadRecipientSuppression(input)
	return suppression && suppression.scope !== 'tracking' ? suppression : null
}

export async function recordVerificationRecipientHardBounce(
	input: HardBounceInput & {
		db: D1Database
		recipient: string
		now?: Date
	},
): Promise<boolean> {
	if (!isHardBounce(input)) return false
	const recipient = canonicalSuppressionRecipient(input.recipient)
	if (!recipient) return false
	const at = (input.now ?? new Date()).toISOString()
	try {
		await input.db
			.prepare(
				`INSERT INTO email_recipient_suppressions (
					recipient, hard_bounce_count, suppressed_at,
					verification_suppressed_at, last_status, last_detail,
					last_hard_bounce_at, created_at, updated_at
				 ) VALUES (?, 0, NULL, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(recipient) DO UPDATE SET
					verification_suppressed_at = excluded.verification_suppressed_at,
					last_status = excluded.last_status,
					last_detail = excluded.last_detail,
					last_hard_bounce_at = excluded.last_hard_bounce_at,
					updated_at = excluded.updated_at`,
			)
			.bind(recipient, at, input.status, hardBounceDetail(input), at, at, at)
			.run()
	} catch (error) {
		if (isMissingSuppressionStore(error)) return false
		throw error
	}
	return true
}

/** Deletes the row: suppression at both levels and the hard-bounce count. */
export async function clearRecipientSuppression(input: {
	db: D1Database
	recipient: string
}): Promise<boolean> {
	const recipient = canonicalSuppressionRecipient(input.recipient)
	if (!recipient) return false
	try {
		const result = await input.db
			.prepare(`DELETE FROM email_recipient_suppressions WHERE recipient = ?`)
			.bind(recipient)
			.run()
		return Number(result.meta.changes ?? 0) > 0
	} catch (error) {
		if (isMissingSuppressionStore(error)) return false
		throw error
	}
}

export async function listRecipientSuppressions(input: {
	db: D1Database
	recipient?: string | null
	includeTracking?: boolean
	limit: number
}): Promise<{ suppressions: Array<RecipientSuppression>; hasMore: boolean }> {
	const recipient = input.recipient
		? canonicalSuppressionRecipient(input.recipient)
		: null
	if (input.recipient && !recipient) return { suppressions: [], hasMore: false }
	const rows = await input.db
		.prepare(
			`SELECT * FROM email_recipient_suppressions
			WHERE (?1 IS NULL OR recipient = ?1)
				AND (?2 = 1 OR suppressed_at IS NOT NULL
					OR verification_suppressed_at IS NOT NULL)
			ORDER BY updated_at DESC, recipient ASC
			LIMIT ?3`,
		)
		.bind(recipient, input.includeTracking ? 1 : 0, input.limit + 1)
		.all<SuppressionRow>()
	const results = rows.results ?? []
	return {
		suppressions: results.slice(0, input.limit).map(mapSuppressionRow),
		hasMore: results.length > input.limit,
	}
}

/** Drops unsuppressed below-threshold rows whose last hard bounce is old. */
export async function pruneRecipientSuppressionTracking(input: {
	db: D1Database
	now: Date
	limit?: number
}): Promise<number> {
	const cutoff = new Date(
		input.now.getTime() -
			recipientSuppressionTrackingRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
	const result = await input.db
		.prepare(
			`DELETE FROM email_recipient_suppressions
			WHERE recipient IN (
				SELECT recipient FROM email_recipient_suppressions
				WHERE suppressed_at IS NULL
					AND verification_suppressed_at IS NULL
					AND last_hard_bounce_at < ?
				ORDER BY last_hard_bounce_at ASC
				LIMIT ?
			)`,
		)
		.bind(cutoff, input.limit ?? 500)
		.run()
	return Number(result.meta.changes ?? 0)
}
