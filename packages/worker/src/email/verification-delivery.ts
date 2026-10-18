import {
	isEmailVerificationDeliveryStatus,
	isEmailVerificationResendBlocked,
	parseEmailVerificationDelivery,
	type EmailVerificationDelivery,
	type EmailVerificationDeliveryClass,
	type EmailVerificationDeliveryStatus,
} from '#universal/email-verification-delivery.ts'
import { type EmailDeliveryStatus } from './types.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const transactionalEmailVerificationKind = 'email_verification'
export const transactionalEmailDestinationVerificationKind =
	'email_destination_verification'
export const transactionalPasswordResetKind = 'password_reset'
export const transactionalPasswordResetConfirmedKind =
	'password_reset_confirmed'

const recipientHardBounceKinds = new Set<string>([
	transactionalEmailVerificationKind,
	transactionalPasswordResetKind,
	transactionalPasswordResetConfirmedKind,
])

/** Verification and password-reset mail record a recipient hard bounce. Mailbox and forwarding kinds do not. */
export function transactionalKindRecordsHardBounce(kind: string) {
	return recipientHardBounceKinds.has(kind)
}

const deliveryDetailMaxLength = 500

const senderBlockPattern =
	/\brlr613\b|\brlr813\b|blacklisted|blacklist|\bdbl\b|spamhaus|blocked.*sender|sender.*blocked|sender domain|blocked by policy|rejected by policy/

export class EmailVerificationSendBlockedError extends Error {
	readonly code = 'sender_block'

	constructor(message?: string) {
		super(
			message ??
				'Your mail provider is blocking our domain right now, try another address.',
		)
		this.name = 'EmailVerificationSendBlockedError'
	}
}

export function classifyVerificationDeliveryFailure(input: {
	status: EmailDeliveryStatus | EmailVerificationDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
}): EmailVerificationDeliveryClass | null {
	const haystack = [
		input.smtpResponse ?? '',
		input.smtpEnhancedStatusCode ?? '',
	]
		.join(' ')
		.toLowerCase()
	const isSenderBlock = senderBlockPattern.test(haystack)
	// Deferred 4xx blocklist rejections (Fastmail RLR613) are retried by the
	// provider for a long time. Classify them immediately so signup stops
	// resending into a known block instead of waiting for the final failure.
	if (input.status === 'deferred') {
		return isSenderBlock ? 'sender_block' : null
	}
	if (
		input.status !== 'bounced' &&
		input.status !== 'failed' &&
		input.status !== 'rejected' &&
		input.status !== 'complained'
	) {
		return null
	}
	if (isSenderBlock) return 'sender_block'
	return 'other'
}

function truncateDeliveryDetail(value: string | null | undefined) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.length > deliveryDetailMaxLength
		? trimmed.slice(0, deliveryDetailMaxLength)
		: trimmed
}

export async function registerTransactionalEmailDelivery(input: {
	db: D1Database
	providerMessageId: string
	userId: number
	recipient: string
	kind?: string
}) {
	const kind = input.kind ?? transactionalEmailVerificationKind
	await input.db
		.prepare(
			`INSERT OR REPLACE INTO transactional_email_delivery_index
			 (provider_message_id, user_id, kind, recipient)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(input.providerMessageId, input.userId, kind, input.recipient)
		.run()
	// Latest send wins for this user + kind + recipient. Extra destination
	// addresses share a kind, so recipient keeps sibling pending sends.
	await input.db
		.prepare(
			`DELETE FROM transactional_email_delivery_index
			 WHERE user_id = ? AND kind = ? AND recipient = ?
			   AND provider_message_id != ?`,
		)
		.bind(input.userId, kind, input.recipient, input.providerMessageId)
		.run()
}

export async function lookupTransactionalEmailDelivery(input: {
	db: D1Database
	providerMessageId: string
}) {
	return await input.db
		.prepare(
			`SELECT provider_message_id, user_id, kind, recipient
			 FROM transactional_email_delivery_index
			 WHERE provider_message_id = ?`,
		)
		.bind(input.providerMessageId)
		.first<{
			provider_message_id: string
			user_id: number
			kind: string
			recipient: string
		}>()
}

export async function loadUserEmailVerificationDelivery(
	db: D1Database,
	userId: number,
): Promise<EmailVerificationDelivery | null> {
	const row = await db
		.prepare(
			`SELECT email_verification_delivery_status, email_verification_delivery_class, email_verification_delivery_at
			 FROM users
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{
			email_verification_delivery_status: string | null
			email_verification_delivery_class: string | null
			email_verification_delivery_at: string | null
		}>()
	if (!row) return null
	return parseEmailVerificationDelivery({
		status: row.email_verification_delivery_status,
		class: row.email_verification_delivery_class,
		at: row.email_verification_delivery_at,
	})
}

export async function setUserEmailVerificationDelivery(input: {
	db: D1Database
	userId: number
	status: EmailVerificationDeliveryStatus
	class?: EmailVerificationDeliveryClass | null
	at?: string | Date
	detail?: string | null
}) {
	const at =
		input.at instanceof Date
			? input.at.toISOString()
			: (input.at ?? new Date().toISOString())
	await input.db
		.prepare(
			`UPDATE users
			 SET email_verification_delivery_status = ?,
			     email_verification_delivery_at = ?,
			     email_verification_delivery_detail = ?,
			     email_verification_delivery_class = ?,
			     updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.status,
			at,
			truncateDeliveryDetail(input.detail),
			input.class ?? null,
			at,
			input.userId,
		)
		.run()
}

export async function clearUserEmailVerificationDelivery(
	db: D1Database,
	userId: number,
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`UPDATE users
			 SET email_verification_delivery_status = NULL,
			     email_verification_delivery_at = NULL,
			     email_verification_delivery_detail = NULL,
			     email_verification_delivery_class = NULL,
			     updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(now, userId)
		.run()
}

export async function assertVerificationResendAllowed(
	db: D1Database,
	userId: number,
) {
	const delivery = await loadUserEmailVerificationDelivery(db, userId)
	if (isEmailVerificationResendBlocked(delivery)) {
		throw new EmailVerificationSendBlockedError()
	}
}

const terminalFailureStatuses = new Set<EmailVerificationDeliveryStatus>([
	'bounced',
	'failed',
	'rejected',
	'complained',
])

export type RecordedTransactionalDelivery = {
	userId: number
	kind: string
	recipient: string
	status: EmailVerificationDeliveryStatus
	class: EmailVerificationDeliveryClass | null
	alreadyTerminal: boolean
}

function isMissingDeliveryCursor(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		error instanceof TypeError ||
		/no such column/i.test(message) ||
		/no such table/i.test(message)
	)
}

function isOlderTransactionalEvent(
	existingAt: string | null | undefined,
	eventTimestamp: string,
) {
	if (!existingAt) return false
	const existingAtMs = Date.parse(existingAt)
	const eventAtMs = Date.parse(eventTimestamp)
	return (
		Number.isFinite(existingAtMs) &&
		Number.isFinite(eventAtMs) &&
		eventAtMs < existingAtMs
	)
}

async function loadTransactionalDeliveryCursor(input: {
	db: D1Database
	providerMessageId: string
}) {
	try {
		return await input.db
			.prepare(
				`SELECT last_status AS lastStatus, last_status_at AS lastStatusAt
				 FROM transactional_email_delivery_index
				 WHERE provider_message_id = ?`,
			)
			.bind(input.providerMessageId)
			.first<{ lastStatus: string | null; lastStatusAt: string | null }>()
	} catch (error) {
		if (isMissingDeliveryCursor(error)) return null
		throw error
	}
}

async function rememberTransactionalDeliveryCursor(input: {
	db: D1Database
	providerMessageId: string
	status: string
	at: string
}) {
	try {
		await input.db
			.prepare(
				`UPDATE transactional_email_delivery_index
				 SET last_status = ?, last_status_at = ?
				 WHERE provider_message_id = ?`,
			)
			.bind(input.status, input.at, input.providerMessageId)
			.run()
	} catch (error) {
		if (isMissingDeliveryCursor(error)) return
		throw error
	}
}

export async function recordTransactionalEmailDeliveryEvent(input: {
	db: D1Database
	providerMessageId: string
	deliveryStatus: EmailDeliveryStatus
	eventTimestamp: string
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
}): Promise<
	| { outcome: 'unmatched' }
	| { outcome: 'stale' }
	| { outcome: 'recorded'; event: RecordedTransactionalDelivery }
> {
	const index = await lookupTransactionalEmailDelivery({
		db: input.db,
		providerMessageId: input.providerMessageId,
	})
	if (!index) {
		return { outcome: 'unmatched' }
	}
	if (!isEmailVerificationDeliveryStatus(input.deliveryStatus)) {
		return { outcome: 'unmatched' }
	}

	if (
		index.kind === transactionalPasswordResetKind ||
		index.kind === transactionalPasswordResetConfirmedKind
	) {
		// Index-only: a reset bounce must not write signup verification
		// columns. A newer status already stored on this message wins, so a
		// late bounce after delivered does not re-suppress the recipient.
		const cursor = await loadTransactionalDeliveryCursor({
			db: input.db,
			providerMessageId: input.providerMessageId,
		})
		if (isOlderTransactionalEvent(cursor?.lastStatusAt, input.eventTimestamp)) {
			return { outcome: 'stale' }
		}
		await rememberTransactionalDeliveryCursor({
			db: input.db,
			providerMessageId: input.providerMessageId,
			status: input.deliveryStatus,
			at: input.eventTimestamp,
		})
		return {
			outcome: 'recorded',
			event: {
				userId: index.user_id,
				kind: index.kind,
				recipient: index.recipient,
				status: input.deliveryStatus,
				class: classifyVerificationDeliveryFailure({
					status: input.deliveryStatus,
					smtpResponse: input.smtpResponse,
					smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
				}),
				alreadyTerminal: false,
			},
		}
	}
	if (index.kind === transactionalEmailDestinationVerificationKind) {
		// Index-only: extra-address verify must not write
		// users.email_verification_delivery_*. Those columns are signup
		// identity verification. Matching here still acks the queue and
		// keeps the provider id attributable for ops queries.
		return {
			outcome: 'recorded',
			event: {
				userId: index.user_id,
				kind: index.kind,
				recipient: index.recipient,
				status: input.deliveryStatus,
				class: classifyVerificationDeliveryFailure({
					status: input.deliveryStatus,
					smtpResponse: input.smtpResponse,
					smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
				}),
				alreadyTerminal: false,
			},
		}
	}
	if (index.kind !== transactionalEmailVerificationKind) {
		return { outcome: 'unmatched' }
	}

	const existing = await loadUserEmailVerificationDelivery(
		input.db,
		index.user_id,
	)
	// `accepted` is stamped on the worker clock after the send API
	// returns. Immediate provider bounces often carry an earlier SMTP
	// timestamp, so comparing those clocks would drop the bounce and
	// leave the account silently pending. Only ignore out-of-order
	// provider lifecycle events against other provider statuses.
	if (existing?.at && existing.status !== 'accepted') {
		const existingAtMs = Date.parse(existing.at)
		const eventAtMs = Date.parse(input.eventTimestamp)
		if (
			Number.isFinite(existingAtMs) &&
			Number.isFinite(eventAtMs) &&
			eventAtMs < existingAtMs
		) {
			// Older than the status already on the user row — do not
			// rewrite delivery state or re-arm deliverability holds.
			return { outcome: 'stale' }
		}
	}
	const alreadyTerminal = Boolean(
		existing && terminalFailureStatuses.has(existing.status),
	)
	const classified = classifyVerificationDeliveryFailure({
		status: input.deliveryStatus,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
	})
	const deliveryClass =
		existing?.class === 'sender_block' && input.deliveryStatus !== 'delivered'
			? 'sender_block'
			: classified
	await setUserEmailVerificationDelivery({
		db: input.db,
		userId: index.user_id,
		status: input.deliveryStatus,
		class: deliveryClass,
		at: input.eventTimestamp,
		detail: input.smtpResponse ?? input.smtpEnhancedStatusCode ?? null,
	})
	return {
		outcome: 'recorded',
		event: {
			userId: index.user_id,
			kind: index.kind,
			recipient: index.recipient,
			status: input.deliveryStatus,
			class: deliveryClass,
			alreadyTerminal,
		},
	}
}
