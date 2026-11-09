import {
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
} from './mailbox-inbound-ledger.ts'
import { mapMailboxDeliveryEventRow } from './mailbox-mappers.ts'
import type {
	MailboxDeliveryEventInput,
	MailboxDeliveryEventRecord,
} from './mailbox-types.ts'

const preClaimAuditPhases = new Set([
	'entitlement',
	'size',
	'account-verification',
	'account-suspension',
	'account-plan',
	'sender-policy',
	'system-limit',
])
const auditDayPattern = /^\d{4}-\d{2}-\d{2}$/

function isCanonicalTimestamp(value: string) {
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function hasNoInboundAuthorityState(
	event: MailboxDeliveryEventInput | MailboxDeliveryEventRecord,
) {
	return (
		event.messageId == null &&
		event.providerMessageId == null &&
		event.providerEventId == null &&
		event.state == null &&
		event.fingerprint == null &&
		event.storageLease == null &&
		event.storageLeaseAt == null &&
		event.cleanupLease == null &&
		event.cleanupLeaseAt == null &&
		event.cleanupRetryAt == null &&
		event.expectedAttachmentCount == null &&
		event.finalizationToken == null &&
		event.reconcileAfter == null &&
		event.dedupeExpiresAt == null &&
		event.usageEffectRecordedAt == null &&
		event.usageEffectSuppressedAt == null &&
		event.usageStartedAt == null &&
		event.usageMonth == null &&
		event.usageBytes == null &&
		event.usageDurationMs == null &&
		event.usageEffectRetryAt == null &&
		event.usageEffectLease == null &&
		event.usageEffectLeaseAt == null &&
		event.subscriptionEffectState == null &&
		event.subscriptionEffectLease == null &&
		event.subscriptionEffectLeaseAt == null &&
		event.subscriptionEffectRetryAt == null &&
		event.subscriptionEffectAttemptCount == null &&
		event.subscriptionEffectDeadLetterAt == null &&
		event.subscriptionEffectLastError == null
	)
}

export function isPreClaimAuditSnapshot(
	event: MailboxDeliveryEventInput | MailboxDeliveryEventRecord,
) {
	if (
		event.provider !== mailboxInboundProvider ||
		event.eventType !== 'rejected' ||
		typeof event.inboxId !== 'string' ||
		event.inboxId.length === 0 ||
		!hasNoInboundAuthorityState(event)
	) {
		return false
	}
	let detail: unknown
	try {
		detail = JSON.parse(event.detailJson)
	} catch {
		return false
	}
	if (
		typeof detail !== 'object' ||
		detail == null ||
		!('aggregate' in detail) ||
		detail.aggregate !== true ||
		!('day' in detail) ||
		typeof detail.day !== 'string' ||
		!auditDayPattern.test(detail.day) ||
		!('count' in detail) ||
		typeof detail.count !== 'number' ||
		!Number.isInteger(detail.count) ||
		detail.count < 1 ||
		!('last_reason' in detail) ||
		typeof detail.last_reason !== 'string' ||
		!('last_phase' in detail) ||
		typeof detail.last_phase !== 'string' ||
		!preClaimAuditPhases.has(detail.last_phase) ||
		!('last_at' in detail) ||
		typeof detail.last_at !== 'string' ||
		!isCanonicalTimestamp(detail.last_at)
	) {
		return false
	}
	return event.id === `email-rejections:${event.inboxId}:${detail.day}`
}

function readMailboxDeliveryEvent(
	sql: SqlStorage,
	eventId: string,
): MailboxDeliveryEventRecord | null {
	const row = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events WHERE id = ? LIMIT 1`,
			eventId,
		)
		.toArray()[0]
	return row ? mapMailboxDeliveryEventRow(row) : null
}

/**
 * Keep bounded pre-claim audits from replacing authoritative Mailbox rows.
 */
export function shouldSkipMailboxDeliveryEventWrite(
	sql: SqlStorage,
	input: {
		event: MailboxDeliveryEventInput
	},
) {
	const preClaimAudit = isPreClaimAuditSnapshot(input.event)
	if (
		(input.event.provider === mailboxInboundProvider ||
			input.event.provider === mailboxInboundDedupeProvider) &&
		!preClaimAudit
	) {
		return true
	}
	if (!preClaimAudit) return false
	const existing = readMailboxDeliveryEvent(sql, input.event.id)
	return existing != null && !isPreClaimAuditSnapshot(existing)
}
