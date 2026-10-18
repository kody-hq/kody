/**
 * Per-recipient hard-bounce suppression for verification mail.
 *
 * Cloudflare lifecycle events already update per-user delivery state. This
 * table stops every later verification send to the same recipient, including
 * a different account that tries the address. A later `delivered` event clears
 * the row. Sender-domain blocklist hits stay on the temporary cooldown path
 * and are not recorded here.
 */

import { normalizeEmailAddress } from './address.ts'
import { parseAccountEmail } from '#worker/identity/account-email-policy.ts'
import { classifyVerificationDeliveryFailure } from './verification-delivery.ts'
import { type EmailDeliveryStatus } from './types.ts'

export const verificationHardBounceMessage =
	'We stopped sending verification email to this address after a previous message bounced. Use a different address, or contact support@kody.codes so we can verify the account another way.'

const detailMaxLength = 500

export type VerificationHardBounceInput = {
	status: EmailDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	smtpStatusCode?: string | null
}

function isMissingPolicyStore(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		error instanceof TypeError ||
		/no such table/i.test(message) ||
		/\.prepare is not a function/i.test(message) ||
		/\.first is not a function/i.test(message) ||
		/\.run is not a function/i.test(message)
	)
}

function permanentSmtpFailure(input: VerificationHardBounceInput) {
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
 * not suppress the address forever.
 */
export function isVerificationHardBounce(input: VerificationHardBounceInput) {
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
function canonicalRecipient(recipient: string) {
	const trimmed = recipient.trim()
	const wrapped = /<([^<>]+)>/u.exec(trimmed)
	const candidate = wrapped?.[1] ?? trimmed
	const parsed = parseAccountEmail(candidate)
	if (parsed) return parsed.email
	return normalizeEmailAddress(trimmed)
}

function truncateDetail(value: string | null | undefined) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.length > detailMaxLength
		? trimmed.slice(0, detailMaxLength)
		: trimmed
}

export async function loadVerificationRecipientHardBounce(input: {
	db: D1Database
	recipient: string
}): Promise<{ recipient: string; status: string } | null> {
	const recipient = canonicalRecipient(input.recipient)
	if (!recipient) return null
	try {
		return await input.db
			.prepare(
				`SELECT recipient, status
				 FROM email_verification_hard_bounces
				 WHERE recipient = ?`,
			)
			.bind(recipient)
			.first<{ recipient: string; status: string }>()
	} catch (error) {
		if (isMissingPolicyStore(error)) return null
		throw error
	}
}

export async function recordVerificationRecipientHardBounce(input: {
	db: D1Database
	recipient: string
	status: EmailDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	smtpStatusCode?: string | null
	now?: Date
}): Promise<boolean> {
	if (
		!isVerificationHardBounce({
			status: input.status,
			smtpResponse: input.smtpResponse,
			smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
			smtpStatusCode: input.smtpStatusCode,
		})
	) {
		return false
	}
	const recipient = canonicalRecipient(input.recipient)
	if (!recipient) return false
	const at = (input.now ?? new Date()).toISOString()
	const detail = truncateDetail(
		input.smtpResponse ??
			input.smtpEnhancedStatusCode ??
			input.smtpStatusCode ??
			null,
	)
	try {
		await input.db
			.prepare(
				`INSERT INTO email_verification_hard_bounces (
					recipient, status, detail, suppressed_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(recipient) DO UPDATE SET
					status = excluded.status,
					detail = excluded.detail,
					suppressed_at = excluded.suppressed_at,
					updated_at = excluded.updated_at`,
			)
			.bind(recipient, input.status, detail, at, at)
			.run()
	} catch (error) {
		if (isMissingPolicyStore(error)) return false
		throw error
	}
	return true
}

export async function clearVerificationRecipientHardBounce(input: {
	db: D1Database
	recipient: string
}) {
	const recipient = canonicalRecipient(input.recipient)
	if (!recipient) return
	try {
		await input.db
			.prepare(
				`DELETE FROM email_verification_hard_bounces WHERE recipient = ?`,
			)
			.bind(recipient)
			.run()
	} catch (error) {
		if (isMissingPolicyStore(error)) return
		throw error
	}
}
