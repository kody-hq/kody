import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxDeliveryEventType,
	assertMailboxInboundDeliveryState,
	assertMailboxNonEmptyString,
	assertMailboxSubscriptionEffectState,
	assertOptionalMailboxCanonicalIsoTimestamp,
	normalizeMailboxPageSize,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
} from './mailbox-types.ts'
import type { EmailDeliveryEventType } from './types.ts'
import { mapMailboxDeliveryEventRow } from './mailbox-mappers.ts'
import { isMailboxMessageTombstoned } from './mailbox-message-deletion-tombstones.ts'

export function findDeliveryEventByProviderEventId(
	sql: SqlStorage,
	providerEventId: string,
): MailboxDeliveryEventRecord | null {
	const row = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events
			WHERE provider_event_id = ?
			LIMIT 1`,
			providerEventId,
		)
		.toArray()[0]
	return row ? mapMailboxDeliveryEventRow(row) : null
}

export function writeMailboxDeliveryEventRow(
	sql: SqlStorage,
	event: MailboxDeliveryEventInput,
): { inserted: boolean; accepted: boolean } {
	const id = assertMailboxNonEmptyString(event.id, 'event.id')
	const messageId =
		event.messageId != null && isMailboxMessageTombstoned(sql, event.messageId)
			? null
			: event.messageId
	const eventType = assertMailboxDeliveryEventType(event.eventType)
	const provider = assertMailboxNonEmptyString(event.provider, 'event.provider')
	const providerEventId = event.providerEventId
	if (providerEventId) {
		const existingByProvider = findDeliveryEventByProviderEventId(
			sql,
			providerEventId,
		)
		if (existingByProvider && existingByProvider.id !== id) {
			return { inserted: false, accepted: false }
		}
	}
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_delivery_events WHERE id = ? LIMIT 1`,
			id,
		)
		.toArray()[0]
	const createdAt = assertMailboxCanonicalIsoTimestamp(
		event.createdAt,
		'event.createdAt',
	)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		event.updatedAt,
		'event.updatedAt',
	)
	if (existing && updatedAt < existing.updated_at) {
		return { inserted: false, accepted: false }
	}
	if (typeof event.detailJson !== 'string') {
		throw new Error('Mailbox event.detailJson must be a string.')
	}
	if (typeof event.needsEffectReconcile !== 'boolean') {
		throw new Error('Mailbox event.needsEffectReconcile must be a boolean.')
	}
	const needsEffectReconcile = event.needsEffectReconcile ? 1 : 0
	const state =
		event.state == null ? null : assertMailboxInboundDeliveryState(event.state)
	const subscriptionEffectState =
		event.subscriptionEffectState == null
			? null
			: assertMailboxSubscriptionEffectState(event.subscriptionEffectState)

	sql.exec(
		`INSERT INTO email_delivery_events (
			id, message_id, inbox_id, event_type, provider,
			provider_message_id, provider_event_id, detail_json,
			needs_effect_reconcile, state, fingerprint,
			storage_lease, storage_lease_at, cleanup_lease, cleanup_lease_at,
			cleanup_retry_at, expected_attachment_count, finalization_token,
			reconcile_after, dedupe_expires_at,
			usage_effect_recorded_at, usage_effect_suppressed_at, usage_started_at,
			usage_month, usage_bytes, usage_duration_ms,
			usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
			subscription_effect_state, subscription_effect_lease,
			subscription_effect_lease_at, subscription_effect_retry_at,
			subscription_effect_attempt_count, subscription_effect_dead_letter_at,
			subscription_effect_last_error, created_at, updated_at
		) VALUES (
			?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		)
		ON CONFLICT(id) DO UPDATE SET
			message_id = excluded.message_id,
			inbox_id = excluded.inbox_id,
			event_type = excluded.event_type,
			provider = excluded.provider,
			provider_message_id = excluded.provider_message_id,
			provider_event_id = excluded.provider_event_id,
			detail_json = excluded.detail_json,
			needs_effect_reconcile = excluded.needs_effect_reconcile,
			state = excluded.state,
			fingerprint = excluded.fingerprint,
			storage_lease = excluded.storage_lease,
			storage_lease_at = excluded.storage_lease_at,
			cleanup_lease = excluded.cleanup_lease,
			cleanup_lease_at = excluded.cleanup_lease_at,
			cleanup_retry_at = excluded.cleanup_retry_at,
			expected_attachment_count = excluded.expected_attachment_count,
			finalization_token = excluded.finalization_token,
			reconcile_after = excluded.reconcile_after,
			dedupe_expires_at = excluded.dedupe_expires_at,
			usage_effect_recorded_at = excluded.usage_effect_recorded_at,
			usage_effect_suppressed_at = excluded.usage_effect_suppressed_at,
			usage_started_at = excluded.usage_started_at,
			usage_month = excluded.usage_month,
			usage_bytes = excluded.usage_bytes,
			usage_duration_ms = excluded.usage_duration_ms,
			usage_effect_retry_at = excluded.usage_effect_retry_at,
			usage_effect_lease = excluded.usage_effect_lease,
			usage_effect_lease_at = excluded.usage_effect_lease_at,
			subscription_effect_state = excluded.subscription_effect_state,
			subscription_effect_lease = excluded.subscription_effect_lease,
			subscription_effect_lease_at = excluded.subscription_effect_lease_at,
			subscription_effect_retry_at = excluded.subscription_effect_retry_at,
			subscription_effect_attempt_count = excluded.subscription_effect_attempt_count,
			subscription_effect_dead_letter_at = excluded.subscription_effect_dead_letter_at,
			subscription_effect_last_error = excluded.subscription_effect_last_error,
			updated_at = excluded.updated_at
		WHERE excluded.updated_at >= email_delivery_events.updated_at`,
		id,
		messageId,
		event.inboxId,
		eventType,
		provider,
		event.providerMessageId,
		providerEventId,
		event.detailJson,
		needsEffectReconcile,
		state,
		event.fingerprint,
		event.storageLease,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.storageLeaseAt,
			'event.storageLeaseAt',
		),
		event.cleanupLease,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.cleanupLeaseAt,
			'event.cleanupLeaseAt',
		),
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.cleanupRetryAt,
			'event.cleanupRetryAt',
		),
		event.expectedAttachmentCount,
		event.finalizationToken,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.reconcileAfter,
			'event.reconcileAfter',
		),
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.dedupeExpiresAt,
			'event.dedupeExpiresAt',
		),
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.usageEffectRecordedAt,
			'event.usageEffectRecordedAt',
		),
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.usageEffectSuppressedAt,
			'event.usageEffectSuppressedAt',
		),
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.usageStartedAt,
			'event.usageStartedAt',
		),
		event.usageMonth,
		event.usageBytes,
		event.usageDurationMs,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.usageEffectRetryAt,
			'event.usageEffectRetryAt',
		),
		event.usageEffectLease,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.usageEffectLeaseAt,
			'event.usageEffectLeaseAt',
		),
		subscriptionEffectState,
		event.subscriptionEffectLease,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.subscriptionEffectLeaseAt,
			'event.subscriptionEffectLeaseAt',
		),
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.subscriptionEffectRetryAt,
			'event.subscriptionEffectRetryAt',
		),
		event.subscriptionEffectAttemptCount,
		assertOptionalMailboxCanonicalIsoTimestamp(
			event.subscriptionEffectDeadLetterAt,
			'event.subscriptionEffectDeadLetterAt',
		),
		event.subscriptionEffectLastError,
		createdAt,
		updatedAt,
	)
	return { inserted: existing == null, accepted: true }
}

export function deliveryEventOwnsMessage(
	sql: SqlStorage,
	eventId: string,
	messageId: string,
) {
	return (
		sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM email_delivery_events
				WHERE id = ? AND message_id = ?
				LIMIT 1`,
				eventId,
				messageId,
			)
			.toArray()[0] != null
	)
}

export function listMailboxDeliveryEvents(
	sql: SqlStorage,
	input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	},
): Array<MailboxDeliveryEventRecord> {
	const limit = normalizeMailboxPageSize(input.limit)
	const clauses: Array<string> = ['1 = 1']
	const params: Array<SqlStorageValue> = []
	if (input.messageId) {
		clauses.push('message_id = ?')
		params.push(input.messageId)
	}
	if (input.eventType) {
		clauses.push('event_type = ?')
		params.push(assertMailboxDeliveryEventType(input.eventType))
	}
	params.push(limit)
	return sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events
			WHERE ${clauses.join(' AND ')}
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
			...params,
		)
		.toArray()
		.map(mapMailboxDeliveryEventRow)
}

export function oldestMailboxDeliveryEventCreatedAt(
	sql: SqlStorage,
): string | null {
	const row = sql
		.exec<{ created_at: string }>(
			`SELECT created_at FROM email_delivery_events
			ORDER BY created_at ASC, id ASC
			LIMIT 1`,
		)
		.toArray()[0]
	return row?.created_at ?? null
}

export function pruneExpiredMailboxDeliveryEvents(
	sql: SqlStorage,
	input: { cutoff: string; limit: number },
) {
	sql.exec(
		`DELETE FROM email_delivery_events
		WHERE id IN (
			SELECT id FROM email_delivery_events
			WHERE created_at < ?
			ORDER BY created_at ASC, id ASC
			LIMIT ?
		)`,
		input.cutoff,
		input.limit,
	)
}

export function hasExpiredMailboxDeliveryEvents(
	sql: SqlStorage,
	cutoff: string,
): boolean {
	return (
		sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM email_delivery_events
				WHERE created_at < ?
				LIMIT 1`,
				cutoff,
			)
			.toArray()[0] != null
	)
}
