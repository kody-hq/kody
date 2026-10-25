import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertOptionalMailboxCanonicalIsoTimestamp,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxPartialMutationResult,
	type MailboxSetMessageClassificationInput,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
} from './mailbox-types.ts'

/**
 * Owner-bound partial mutation helpers for Mailbox SQLite metadata.
 * No R2 / alarm side effects — callers own transactions.
 */

export function touchMailboxThread(
	sql: SqlStorage,
	input: Omit<MailboxTouchThreadInput, 'ownerId'>,
): MailboxPartialMutationResult {
	const threadId = assertMailboxNonEmptyString(input.threadId, 'threadId')
	const lastMessageAt = assertMailboxCanonicalIsoTimestamp(
		input.lastMessageAt,
		'lastMessageAt',
	)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_threads WHERE id = ? LIMIT 1`,
			threadId,
		)
		.toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > updatedAt) return { status: 'stale' }

	sql.exec(
		`UPDATE email_threads
		SET last_message_at = CASE
				WHEN last_message_at < ? THEN ?
				ELSE last_message_at
			END,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		lastMessageAt,
		lastMessageAt,
		updatedAt,
		threadId,
		updatedAt,
	)
	return { status: 'accepted' }
}

export function updateMailboxMessageDelivery(
	sql: SqlStorage,
	input: Omit<MailboxUpdateMessageDeliveryInput, 'ownerId'>,
): MailboxPartialMutationResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const processingStatus = assertMailboxProcessingStatus(input.processingStatus)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const sentAt = assertOptionalMailboxCanonicalIsoTimestamp(
		input.sentAt,
		'sentAt',
	)
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_messages WHERE id = ? LIMIT 1`,
			messageId,
		)
		.toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > updatedAt) return { status: 'stale' }

	sql.exec(
		`UPDATE email_messages
		SET processing_status = ?,
			provider_message_id = ?,
			error = ?,
			sent_at = ?,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		processingStatus,
		input.providerMessageId,
		input.error,
		sentAt,
		updatedAt,
		messageId,
		updatedAt,
	)
	return { status: 'accepted' }
}

export function setMailboxMessageClassification(
	sql: SqlStorage,
	input: Omit<MailboxSetMessageClassificationInput, 'ownerId'>,
): MailboxPartialMutationResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const assignments: Array<string> = []
	const values: Array<SqlStorageValue> = []
	if (input.classification !== undefined) {
		assignments.push('classification = ?', 'classification_reason = ?')
		values.push(
			assertMailboxClassification(input.classification),
			input.classificationReason ?? null,
		)
	}
	if (input.archivedAt !== undefined) {
		assignments.push('archived_at = ?')
		values.push(
			assertOptionalMailboxCanonicalIsoTimestamp(
				input.archivedAt,
				'archivedAt',
			),
		)
	}
	if (assignments.length === 0) {
		throw new Error(
			'Mailbox message triage update requires classification or archivedAt.',
		)
	}
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_messages WHERE id = ? LIMIT 1`,
			messageId,
		)
		.toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > updatedAt) return { status: 'stale' }

	sql.exec(
		`UPDATE email_messages
		SET ${assignments.join(', ')},
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		...values,
		updatedAt,
		messageId,
		updatedAt,
	)
	return { status: 'accepted' }
}

/**
 * Delete message + attachment metadata. Nulls delivery-event `message_id`
 * first so retained events cannot reference deleted metadata. Never deletes R2
 * or empty threads.
 */
export function deleteMailboxMessageMetadata(
	sql: SqlStorage,
	input: Omit<MailboxDeleteMessageMetadataInput, 'ownerId'>,
): MailboxDeleteResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_messages
			WHERE id = ?
			LIMIT 1`,
			messageId,
		)
		.toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > deletedAt) return { status: 'stale' }

	sql.exec(
		`UPDATE email_delivery_events
		SET message_id = NULL
		WHERE message_id = ?`,
		messageId,
	)
	sql.exec(`DELETE FROM email_attachments WHERE message_id = ?`, messageId)
	sql.exec(
		`DELETE FROM email_message_retention_retries WHERE message_id = ?`,
		messageId,
	)
	sql.exec(
		`DELETE FROM email_messages
		WHERE id = ?
			AND updated_at <= ?`,
		messageId,
		deletedAt,
	)
	return { status: 'deleted' }
}

/**
 * Delete a delivery-event row. SELECT `updated_at` first so missing and stale
 * are distinguishable.
 */
export function deleteMailboxDeliveryEvent(
	sql: SqlStorage,
	input: Omit<MailboxDeleteDeliveryEventInput, 'ownerId'>,
): MailboxDeleteResult {
	const eventId = assertMailboxNonEmptyString(input.eventId, 'eventId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_delivery_events
			WHERE id = ?
			LIMIT 1`,
			eventId,
		)
		.toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > deletedAt) return { status: 'stale' }

	sql.exec(
		`DELETE FROM email_delivery_events
		WHERE id = ?
			AND updated_at <= ?`,
		eventId,
		deletedAt,
	)
	return { status: 'deleted' }
}

/**
 * Delete a thread only when it has no messages. Stale-safe by
 * `thread.updated_at`. Not-empty / already-absent → `missing` (idempotent).
 */
export function deleteMailboxThreadIfEmpty(
	sql: SqlStorage,
	input: Omit<MailboxDeleteThreadIfEmptyInput, 'ownerId'>,
): MailboxDeleteResult {
	const threadId = assertMailboxNonEmptyString(input.threadId, 'threadId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_threads
			WHERE id = ?
			LIMIT 1`,
			threadId,
		)
		.toArray()[0]
	if (existing == null) return { status: 'missing' }
	if (existing.updated_at > deletedAt) return { status: 'stale' }

	const cursor = sql.exec(
		`DELETE FROM email_threads
		WHERE id = ?
			AND updated_at <= ?
			AND NOT EXISTS (
				SELECT 1 FROM email_messages
				WHERE thread_id = ?
			)`,
		threadId,
		deletedAt,
		threadId,
	)
	return cursor.rowsWritten > 0 ? { status: 'deleted' } : { status: 'missing' }
}
