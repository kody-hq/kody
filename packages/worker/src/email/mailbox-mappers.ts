import {
	maxRestorableTextColumnBytes,
	truncateToUtf8Bytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { parseJsonArray } from '@kody-internal/shared/json-parsing.ts'
import {
	emailClassificationValues,
	emailDeliveryEventTypeValues,
	emailDeliveryStatusValues,
	emailDirectionValues,
	emailProcessingStatusValues,
	type EmailClassification,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailProcessingStatus,
} from './types.ts'
import {
	mailboxInboundDeliveryStateValues,
	mailboxStorageKindValues,
	mailboxSubscriptionEffectStateValues,
	type MailboxAttachmentRecord,
	type MailboxDeliveryEventRecord,
	type MailboxInboundDeliveryState,
	type MailboxMessageRecord,
	type MailboxStorageKind,
	type MailboxSubscriptionEffectState,
	type MailboxThreadRecord,
} from './mailbox-types.ts'

const emailBodyTruncationNotice =
	'\n[truncated for backup-safe storage; the full message is retained in the raw MIME object]'

export function boundedEmailBody(
	body: string | null | undefined,
): string | null {
	if (body == null) return null
	if (utf8ByteLength(body) <= maxRestorableTextColumnBytes) return body
	return (
		truncateToUtf8Bytes(
			body,
			maxRestorableTextColumnBytes - utf8ByteLength(emailBodyTruncationNotice),
		) + emailBodyTruncationNotice
	)
}

function parseOptionalJsonRecord(value: string | null) {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		return parsed as Record<string, unknown>
	} catch {
		return null
	}
}

function requirePersistedEnum<T extends string>(
	values: ReadonlyArray<T>,
	value: unknown,
	label: string,
): T {
	const raw = String(value ?? '')
	if (!(values as ReadonlyArray<string>).includes(raw)) {
		throw new Error(
			`Mailbox persisted ${label} is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return raw as T
}

function requireOptionalPersistedEnum<T extends string>(
	values: ReadonlyArray<T>,
	value: unknown,
	label: string,
): T | null {
	if (value == null) return null
	return requirePersistedEnum(values, value, label)
}

export function mapMailboxThreadRow(
	row: Record<string, SqlStorageValue>,
): MailboxThreadRecord {
	return {
		id: String(row['id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		subjectNormalized:
			row['subject_normalized'] == null
				? null
				: String(row['subject_normalized']),
		rootMessageIdHeader:
			row['root_message_id_header'] == null
				? null
				: String(row['root_message_id_header']),
		lastMessageAt: String(row['last_message_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export function mapMailboxMessageRow(
	row: Record<string, SqlStorageValue>,
): MailboxMessageRecord {
	return {
		id: String(row['id']),
		direction: requirePersistedEnum(
			emailDirectionValues,
			row['direction'],
			'direction',
		) as EmailDirection,
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		threadId: row['thread_id'] == null ? null : String(row['thread_id']),
		senderIdentityId:
			row['sender_identity_id'] == null
				? null
				: String(row['sender_identity_id']),
		fromAddress:
			row['from_address'] == null ? null : String(row['from_address']),
		envelopeFrom:
			row['envelope_from'] == null ? null : String(row['envelope_from']),
		toAddresses: parseJsonArray(String(row['to_addresses_json'] ?? '[]')),
		ccAddresses: parseJsonArray(String(row['cc_addresses_json'] ?? '[]')),
		bccAddresses: parseJsonArray(String(row['bcc_addresses_json'] ?? '[]')),
		replyToAddresses: parseJsonArray(
			String(row['reply_to_addresses_json'] ?? '[]'),
		),
		subject: row['subject'] == null ? null : String(row['subject']),
		messageIdHeader:
			row['message_id_header'] == null
				? null
				: String(row['message_id_header']),
		inReplyToHeader:
			row['in_reply_to_header'] == null
				? null
				: String(row['in_reply_to_header']),
		references: parseJsonArray(String(row['references_json'] ?? '[]')),
		headers: parseOptionalJsonRecord(
			row['headers_json'] == null ? null : String(row['headers_json']),
		),
		authResults:
			row['auth_results'] == null ? null : String(row['auth_results']),
		textBody: row['text_body'] == null ? null : String(row['text_body']),
		htmlBody: row['html_body'] == null ? null : String(row['html_body']),
		rawMimeKey:
			row['raw_mime_key'] == null ? null : String(row['raw_mime_key']),
		rawSize: row['raw_size'] == null ? null : Number(row['raw_size']) || 0,
		processingStatus: requirePersistedEnum(
			emailProcessingStatusValues,
			row['processing_status'],
			'processingStatus',
		) as EmailProcessingStatus,
		classification: requirePersistedEnum(
			emailClassificationValues,
			row['classification'],
			'classification',
		) as EmailClassification,
		classificationReason:
			row['classification_reason'] == null
				? null
				: String(row['classification_reason']),
		archivedAt: row['archived_at'] == null ? null : String(row['archived_at']),
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		deliveryStatus: requireOptionalPersistedEnum(
			emailDeliveryStatusValues,
			row['delivery_status'],
			'deliveryStatus',
		) as EmailDeliveryStatus | null,
		deliveryStatusAt:
			row['delivery_status_at'] == null
				? null
				: String(row['delivery_status_at']),
		error: row['error'] == null ? null : String(row['error']),
		receivedAt: row['received_at'] == null ? null : String(row['received_at']),
		sentAt: row['sent_at'] == null ? null : String(row['sent_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export function mapMailboxAttachmentRow(
	row: Record<string, SqlStorageValue>,
): MailboxAttachmentRecord {
	return {
		id: String(row['id']),
		messageId: String(row['message_id']),
		filename: row['filename'] == null ? null : String(row['filename']),
		contentType:
			row['content_type'] == null ? null : String(row['content_type']),
		contentId: row['content_id'] == null ? null : String(row['content_id']),
		disposition: row['disposition'] == null ? null : String(row['disposition']),
		size: Number(row['size'] ?? 0) || 0,
		storageKind: requirePersistedEnum(
			mailboxStorageKindValues,
			row['storage_kind'],
			'storageKind',
		) as MailboxStorageKind,
		storageKey: row['storage_key'] == null ? null : String(row['storage_key']),
		createdAt: String(row['created_at']),
	}
}

export function mapMailboxDeliveryEventRow(
	row: Record<string, SqlStorageValue>,
): MailboxDeliveryEventRecord {
	return {
		id: String(row['id']),
		messageId: row['message_id'] == null ? null : String(row['message_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		eventType: requirePersistedEnum(
			emailDeliveryEventTypeValues,
			row['event_type'],
			'eventType',
		) as EmailDeliveryEventType,
		provider: row['provider'] == null ? null : String(row['provider']),
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		providerEventId:
			row['provider_event_id'] == null
				? null
				: String(row['provider_event_id']),
		detailJson: String(row['detail_json'] ?? '{}'),
		needsEffectReconcile: Number(row['needs_effect_reconcile'] ?? 0) === 1,
		state: requireOptionalPersistedEnum(
			mailboxInboundDeliveryStateValues,
			row['state'],
			'state',
		) as MailboxInboundDeliveryState | null,
		fingerprint: row['fingerprint'] == null ? null : String(row['fingerprint']),
		storageLease:
			row['storage_lease'] == null ? null : String(row['storage_lease']),
		storageLeaseAt:
			row['storage_lease_at'] == null ? null : String(row['storage_lease_at']),
		cleanupLease:
			row['cleanup_lease'] == null ? null : String(row['cleanup_lease']),
		cleanupLeaseAt:
			row['cleanup_lease_at'] == null ? null : String(row['cleanup_lease_at']),
		cleanupRetryAt:
			row['cleanup_retry_at'] == null ? null : String(row['cleanup_retry_at']),
		expectedAttachmentCount:
			row['expected_attachment_count'] == null
				? null
				: Number(row['expected_attachment_count']) || 0,
		finalizationToken:
			row['finalization_token'] == null
				? null
				: String(row['finalization_token']),
		reconcileAfter:
			row['reconcile_after'] == null ? null : String(row['reconcile_after']),
		dedupeExpiresAt:
			row['dedupe_expires_at'] == null
				? null
				: String(row['dedupe_expires_at']),
		usageEffectRecordedAt:
			row['usage_effect_recorded_at'] == null
				? null
				: String(row['usage_effect_recorded_at']),
		usageEffectSuppressedAt:
			row['usage_effect_suppressed_at'] == null
				? null
				: String(row['usage_effect_suppressed_at']),
		usageStartedAt:
			row['usage_started_at'] == null ? null : String(row['usage_started_at']),
		usageMonth: row['usage_month'] == null ? null : String(row['usage_month']),
		usageBytes:
			row['usage_bytes'] == null ? null : Number(row['usage_bytes']) || 0,
		usageDurationMs:
			row['usage_duration_ms'] == null
				? null
				: Number(row['usage_duration_ms']) || 0,
		usageEffectRetryAt:
			row['usage_effect_retry_at'] == null
				? null
				: String(row['usage_effect_retry_at']),
		usageEffectLease:
			row['usage_effect_lease'] == null
				? null
				: String(row['usage_effect_lease']),
		usageEffectLeaseAt:
			row['usage_effect_lease_at'] == null
				? null
				: String(row['usage_effect_lease_at']),
		subscriptionEffectState: requireOptionalPersistedEnum(
			mailboxSubscriptionEffectStateValues,
			row['subscription_effect_state'],
			'subscriptionEffectState',
		) as MailboxSubscriptionEffectState | null,
		subscriptionEffectLease:
			row['subscription_effect_lease'] == null
				? null
				: String(row['subscription_effect_lease']),
		subscriptionEffectLeaseAt:
			row['subscription_effect_lease_at'] == null
				? null
				: String(row['subscription_effect_lease_at']),
		subscriptionEffectRetryAt:
			row['subscription_effect_retry_at'] == null
				? null
				: String(row['subscription_effect_retry_at']),
		subscriptionEffectAttemptCount:
			row['subscription_effect_attempt_count'] == null
				? null
				: Number(row['subscription_effect_attempt_count']) || 0,
		subscriptionEffectDeadLetterAt:
			row['subscription_effect_dead_letter_at'] == null
				? null
				: String(row['subscription_effect_dead_letter_at']),
		subscriptionEffectLastError:
			row['subscription_effect_last_error'] == null
				? null
				: String(row['subscription_effect_last_error']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}
