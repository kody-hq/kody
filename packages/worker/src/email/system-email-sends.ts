/**
 * Record of mail sent from reserved system senders (`kody@` transactional
 * mail through `sendGatedTransactionalEmail`, and operator correspondence
 * through `sendSystemEmail`). Cloudflare reports delivery status for every
 * message the account sends; this table is what lets reports for system mail
 * match a send instead of arriving unmatched. Matched hard bounces feed
 * `email_recipient_suppressions` (see `recipient-suppression.ts`).
 */

import type { EmailDeliveryStatus } from './types.ts'
import {
	canonicalSuppressionRecipient,
	hardBounceDetail,
	isHardBounce,
	isMissingSuppressionStore,
	systemEmailHardBounceSuppressionThreshold,
} from './recipient-suppression.ts'

export const systemEmailSendRetentionDays = 90

/** Operator correspondence sent with `adminSystemEmailSend`. */
export const systemEmailOperatorSendKind = 'operator'

export type SystemEmailSend = {
	providerMessageId: string
	recipient: string
	sender: string
	kind: string
}

/** Canonical UTC ISO so lexical and instant order match. */
function canonicalIsoTimestamp(value: string): string {
	const ms = Date.parse(value)
	if (!Number.isFinite(ms)) return value
	return new Date(ms).toISOString()
}

/**
 * Best effort: the message is already sent, so a failed write only costs
 * report matching for it. Never throws.
 */
export async function recordSystemEmailSends(input: {
	db: D1Database
	providerMessageId: string | null | undefined
	recipients: ReadonlyArray<string>
	sender: string
	kind: string
	now?: Date
}): Promise<void> {
	if (!input.providerMessageId) return
	const sentAt = (input.now ?? new Date()).toISOString()
	const recipients = [
		...new Set(
			input.recipients
				.map((recipient) => canonicalSuppressionRecipient(recipient))
				.filter((recipient): recipient is string => Boolean(recipient)),
		),
	]
	if (recipients.length === 0) return
	try {
		await input.db.batch(
			recipients.map((recipient) =>
				input.db
					.prepare(
						`INSERT INTO system_email_sends (
							provider_message_id, recipient, sender, kind, sent_at
						) VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(provider_message_id, recipient) DO NOTHING`,
					)
					.bind(
						input.providerMessageId,
						recipient,
						input.sender,
						input.kind,
						sentAt,
					),
			),
		)
	} catch (error) {
		if (isMissingSuppressionStore(error)) return
		console.warn('system-email-send-record-failed', {
			kind: input.kind,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

type SendRow = {
	provider_message_id: string
	recipient: string
	sender: string
	kind: string
	last_status: string | null
	last_status_at: string | null
}

async function lookupSystemEmailSend(input: {
	db: D1Database
	providerMessageId: string
	recipient: string
}): Promise<SendRow | null> {
	const rows = await input.db
		.prepare(
			`SELECT provider_message_id, recipient, sender, kind, last_status,
				last_status_at
			FROM system_email_sends
			WHERE provider_message_id = ?
			LIMIT 6`,
		)
		.bind(input.providerMessageId)
		.all<SendRow>()
	const results = rows.results ?? []
	const recipient = canonicalSuppressionRecipient(input.recipient)
	const exact = results.find((row) => row.recipient === recipient)
	if (exact) return exact
	// A single-recipient message whose report spells the address differently.
	return results.length === 1 ? results[0]! : null
}

async function readSendCursor(input: {
	db: D1Database
	providerMessageId: string
	recipient: string
}) {
	return await input.db
		.prepare(
			`SELECT last_status AS lastStatus, last_status_at AS lastStatusAt
			FROM system_email_sends
			WHERE provider_message_id = ? AND recipient = ?`,
		)
		.bind(input.providerMessageId, input.recipient)
		.first<{ lastStatus: string | null; lastStatusAt: string | null }>()
}

/**
 * Advance the per-send status cursor when this event is strictly newer.
 * A retry of the event that already holds the cursor counts as recorded so
 * side effects can finish; an equal-instant different status loses.
 */
async function claimSendCursor(input: {
	db: D1Database
	providerMessageId: string
	recipient: string
	status: string
	at: string
}): Promise<'recorded' | 'stale'> {
	const result = await input.db
		.prepare(
			`UPDATE system_email_sends
			SET last_status = ?, last_status_at = ?
			WHERE provider_message_id = ? AND recipient = ?
				AND (last_status_at IS NULL OR last_status_at < ?)`,
		)
		.bind(
			input.status,
			input.at,
			input.providerMessageId,
			input.recipient,
			input.at,
		)
		.run()
	if (Number(result.meta.changes ?? 0) > 0) return 'recorded'
	const cursor = await readSendCursor(input)
	return cursor?.lastStatus === input.status && cursor.lastStatusAt === input.at
		? 'recorded'
		: 'stale'
}

/** Guard for deliverability side effects keyed on one system send. */
export function systemEmailSendCursorGuard(input: {
	db: D1Database
	providerMessageId: string
	recipient: string
	status: string
	at: string
}) {
	const at = canonicalIsoTimestamp(input.at)
	return {
		async ownsEvent() {
			const cursor = await readSendCursor(input)
			return cursor?.lastStatus === input.status && cursor.lastStatusAt === at
		},
		async deliveredWon() {
			const cursor = await readSendCursor(input)
			return cursor?.lastStatus === 'delivered'
		},
	}
}

/**
 * Count one hard bounce per send (idempotent across queue retries: the
 * count only moves in the batch where `hard_bounced_at` was first set) and
 * suppress the recipient once the count reaches the threshold. A bounce older
 * than a delivery already recorded for the recipient on another send is not
 * counted: reports can arrive out of order across sends, and that delivery
 * already cleared the suppression the bounce would rebuild.
 */
async function countSendHardBounce(input: {
	db: D1Database
	providerMessageId: string
	recipient: string
	status: EmailDeliveryStatus
	detail: string | null
	at: string
}): Promise<{ counted: boolean; suppressed: boolean }> {
	const results = await input.db.batch([
		input.db
			.prepare(
				`UPDATE system_email_sends SET hard_bounced_at = ?1
				WHERE provider_message_id = ?2 AND recipient = ?3
					AND hard_bounced_at IS NULL
					AND NOT EXISTS (
						SELECT 1 FROM system_email_sends AS later
						WHERE later.recipient = ?3
							AND later.last_status = 'delivered'
							AND later.last_status_at > ?1
					)`,
			)
			.bind(input.at, input.providerMessageId, input.recipient),
		input.db
			.prepare(
				`INSERT INTO email_recipient_suppressions (
					recipient, hard_bounce_count, suppressed_at,
					verification_suppressed_at, last_status, last_detail,
					last_hard_bounce_at, created_at, updated_at
				)
				SELECT ?1, 1, CASE WHEN 1 >= ?2 THEN ?5 END, NULL, ?3, ?4, ?5, ?5, ?5
				WHERE changes() > 0
				ON CONFLICT(recipient) DO UPDATE SET
					hard_bounce_count = hard_bounce_count + 1,
					suppressed_at = COALESCE(
						suppressed_at,
						CASE WHEN hard_bounce_count + 1 >= ?2 THEN excluded.updated_at END
					),
					last_status = excluded.last_status,
					last_detail = excluded.last_detail,
					last_hard_bounce_at = excluded.last_hard_bounce_at,
					updated_at = excluded.updated_at`,
			)
			.bind(
				input.recipient,
				systemEmailHardBounceSuppressionThreshold,
				input.status,
				input.detail,
				input.at,
			),
	])
	const counted = Number(results[1]?.meta.changes ?? 0) > 0
	if (!counted) return { counted, suppressed: false }
	const row = await input.db
		.prepare(
			`SELECT suppressed_at FROM email_recipient_suppressions
			WHERE recipient = ?`,
		)
		.bind(input.recipient)
		.first<{ suppressed_at: string | null }>()
	return { counted, suppressed: row?.suppressed_at != null }
}

export type SystemEmailSendDeliveryResult =
	| { outcome: 'unmatched' }
	| { outcome: 'stale'; send: SystemEmailSend }
	| {
			outcome: 'recorded'
			send: SystemEmailSend
			hardBounceCounted: boolean
			suppressed: boolean
	  }

export async function recordSystemEmailSendDeliveryEvent(input: {
	db: D1Database
	providerMessageId: string
	recipient: string
	deliveryStatus: EmailDeliveryStatus
	eventTimestamp: string
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	smtpStatusCode?: string | null
}): Promise<SystemEmailSendDeliveryResult> {
	let row: SendRow | null
	try {
		row = await lookupSystemEmailSend(input)
	} catch (error) {
		if (isMissingSuppressionStore(error)) return { outcome: 'unmatched' }
		throw error
	}
	if (!row) return { outcome: 'unmatched' }
	const send: SystemEmailSend = {
		providerMessageId: row.provider_message_id,
		recipient: row.recipient,
		sender: row.sender,
		kind: row.kind,
	}
	const at = canonicalIsoTimestamp(input.eventTimestamp)
	const claim = await claimSendCursor({
		db: input.db,
		providerMessageId: send.providerMessageId,
		recipient: send.recipient,
		status: input.deliveryStatus,
		at,
	})
	if (claim === 'stale') return { outcome: 'stale', send }
	const bounce = {
		status: input.deliveryStatus,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
		smtpStatusCode: input.smtpStatusCode,
	}
	if (!isHardBounce(bounce)) {
		return {
			outcome: 'recorded',
			send,
			hardBounceCounted: false,
			suppressed: false,
		}
	}
	const counted = await countSendHardBounce({
		db: input.db,
		providerMessageId: send.providerMessageId,
		recipient: send.recipient,
		status: input.deliveryStatus,
		detail: hardBounceDetail(bounce),
		at,
	})
	return {
		outcome: 'recorded',
		send,
		hardBounceCounted: counted.counted,
		suppressed: counted.suppressed,
	}
}

export async function pruneSystemEmailSends(input: {
	db: D1Database
	now: Date
	limit?: number
}): Promise<number> {
	const cutoff = new Date(
		input.now.getTime() - systemEmailSendRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
	const result = await input.db
		.prepare(
			`DELETE FROM system_email_sends
			WHERE rowid IN (
				SELECT rowid FROM system_email_sends
				WHERE sent_at < ?
				ORDER BY sent_at ASC
				LIMIT ?
			)`,
		)
		.bind(cutoff, input.limit ?? 1000)
		.run()
	return Number(result.meta.changes ?? 0)
}
