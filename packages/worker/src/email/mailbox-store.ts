import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxDeliveryStatus,
	assertMailboxDirection,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertMailboxStorageKind,
	assertMailboxView,
	assertOptionalMailboxCanonicalIsoTimestamp,
	decodeMailboxListCursor,
	encodeMailboxListCursor,
	mailboxMetaSchemaVersionKey,
	mailboxNowIso,
	normalizeMailboxOffset,
	normalizeMailboxPageSize,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxListMessagesInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxRestoreStatus,
	type MailboxSearchMessagesInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from './mailbox-types.ts'
import {
	emailMessageViewSqlClauses,
	type EmailClassification,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageView,
	type EmailProcessingStatus,
} from './types.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	boundedEmailBody,
	mapMailboxAttachmentRow,
	mapMailboxMessageRow,
	mapMailboxThreadRow,
} from './mailbox-mappers.ts'
import {
	deliveryEventOwnsMessage,
	hasExpiredMailboxDeliveryEvents,
	listMailboxDeliveryEvents,
	oldestMailboxDeliveryEventCreatedAt,
	pruneExpiredMailboxDeliveryEvents,
	writeMailboxDeliveryEventRow,
} from './mailbox-delivery-events.ts'
import {
	exportMailboxFromStore,
	listMailboxBlobReferences,
} from './mailbox-export.ts'
import { initializeMailboxSchema } from './mailbox-schema.ts'
import {
	isMailboxMessageTombstoned,
	writeMailboxMessageDeletionTombstone,
} from './mailbox-message-deletion-tombstones.ts'

export type MailboxUpsertResult = {
	created: boolean
	accepted: boolean
}

/**
 * Every `email_messages` column except the two body texts. Kept in schema
 * order so a new metadata column is an obvious omission next to the DDL.
 */
export const mailboxMessageMetadataColumnList = [
	'id',
	'direction',
	'inbox_id',
	'thread_id',
	'sender_identity_id',
	'from_address',
	'envelope_from',
	'to_addresses_json',
	'cc_addresses_json',
	'bcc_addresses_json',
	'reply_to_addresses_json',
	'subject',
	'message_id_header',
	'in_reply_to_header',
	'references_json',
	'headers_json',
	'auth_results',
	'raw_mime_key',
	'raw_size',
	'processing_status',
	'classification',
	'classification_reason',
	'provider_message_id',
	'delivery_status',
	'delivery_status_at',
	'error',
	'received_at',
	'sent_at',
	'created_at',
	'updated_at',
	'archived_at',
] as const

const mailboxMessageMetadataColumns =
	mailboxMessageMetadataColumnList.join(', ')

const mailboxRestorePendingMetaKey = 'restore_pending'
const mailboxDrillResultMetaKeys = {
	present: 'drill_result_present',
	threads: 'drill_result_threads',
	messages: 'drill_result_messages',
	attachments: 'drill_result_attachments',
	deliveryEvents: 'drill_result_delivery_events',
} as const

function buildMailboxMessageFilterClauses(input: {
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	view?: EmailMessageView | null
	query?: string | null
}): { clauses: Array<string>; params: Array<SqlStorageValue> } {
	const clauses: Array<string> = ['1 = 1']
	const params: Array<SqlStorageValue> = []
	if (typeof input.query === 'string') {
		// Substring match via INSTR — DO SQLite rejects LIKE/GLOB patterns over
		// 50 bytes (Cloudflare limit), and MCP allows queries up to 256 chars.
		const needle = input.query.trim().toLowerCase()
		clauses.push(`(
			INSTR(LOWER(subject), ?) > 0
			OR INSTR(LOWER(from_address), ?) > 0
			OR INSTR(LOWER(COALESCE(envelope_from, '')), ?) > 0
		)`)
		params.push(needle, needle, needle)
	}
	if (input.inboxId) {
		clauses.push('inbox_id = ?')
		params.push(input.inboxId)
	}
	if (input.direction) {
		clauses.push('direction = ?')
		params.push(assertMailboxDirection(input.direction))
	}
	if (input.processingStatus) {
		clauses.push('processing_status = ?')
		params.push(assertMailboxProcessingStatus(input.processingStatus))
	}
	if (input.deliveryStatus) {
		clauses.push('delivery_status = ?')
		params.push(assertMailboxDeliveryStatus(input.deliveryStatus))
	}
	if (input.classification) {
		clauses.push('classification = ?')
		params.push(assertMailboxClassification(input.classification))
	}
	if (input.view) {
		clauses.push(...emailMessageViewSqlClauses(assertMailboxView(input.view)))
	}
	return { clauses, params }
}

/**
 * SQLite write/query helpers for one Mailbox DO. No alarm / R2 side effects.
 *
 * USER inbound ledger/effect CAS helpers live in
 * `mailbox-inbound-ledger.ts` / `mailbox-inbound-effect-ledger.ts` and are
 * authoritative. Generic mirror upserts are fenced from USER inbound providers;
 * only the missing-row bootstrap bridge may insert those snapshots.
 */
export class MailboxStore {
	private readonly storage: DurableObjectStorage

	constructor(storage: DurableObjectStorage) {
		this.storage = storage
	}

	private get sql() {
		return this.storage.sql
	}

	initializeSchema() {
		initializeMailboxSchema(this.storage)
	}

	getOwnerId(): OwnerId | null {
		const row = this.sql
			.exec<{ owner_id: OwnerId }>(
				`SELECT owner_id FROM mailbox_owner_identity
				WHERE singleton = 1
				LIMIT 1`,
			)
			.toArray()[0]
		return row?.owner_id ?? null
	}

	isMessageTombstoned(messageId: string): boolean {
		return isMailboxMessageTombstoned(this.sql, messageId)
	}

	/**
	 * Persist owner once; reject cross-user writes. DO name is not
	 * introspectable — see mailbox_owner_identity DDL comment.
	 */
	assertOwner(ownerId: OwnerId): OwnerId {
		const id = assertMailboxNonEmptyString(ownerId, 'ownerId')
		const existing = this.getOwnerId()
		if (existing == null) {
			this.sql.exec(
				`INSERT INTO mailbox_owner_identity (singleton, owner_id)
				VALUES (1, ?)`,
				id,
			)
			return id
		}
		if (existing !== id) {
			throw new Error(
				`Mailbox ownerId mismatch; this object is bound to a different owner.`,
			)
		}
		return id
	}

	isRestorePending(): boolean {
		const row = this.sql
			.exec<{ value: number }>(
				`SELECT value FROM mailbox_meta WHERE key = ? LIMIT 1`,
				mailboxRestorePendingMetaKey,
			)
			.toArray()[0]
		return Number(row?.value ?? 0) === 1
	}

	assertReadable(): void {
		if (this.isRestorePending()) {
			throw new Error('Mailbox restore is in progress.')
		}
	}

	beginRestore(ownerId: OwnerId): void {
		this.assertOwner(ownerId)
		this.clearDrillResult()
		this.sql.exec(
			`INSERT INTO mailbox_meta (key, value)
			VALUES (?, 1)
			ON CONFLICT(key) DO UPDATE SET value = 1`,
			mailboxRestorePendingMetaKey,
		)
	}

	finalizeRestore(ownerId: OwnerId): void {
		this.assertOwner(ownerId)
		this.sql.exec(
			`DELETE FROM mailbox_meta WHERE key = ?`,
			mailboxRestorePendingMetaKey,
		)
	}

	private clearDrillResult(): void {
		this.sql.exec(
			`DELETE FROM mailbox_meta WHERE key IN (?, ?, ?, ?, ?)`,
			mailboxDrillResultMetaKeys.present,
			mailboxDrillResultMetaKeys.threads,
			mailboxDrillResultMetaKeys.messages,
			mailboxDrillResultMetaKeys.attachments,
			mailboxDrillResultMetaKeys.deliveryEvents,
		)
	}

	readDrillResult(): MailboxCountResult | null {
		const rows = this.sql
			.exec<{ key: string; value: number }>(
				`SELECT key, value FROM mailbox_meta
				WHERE key IN (?, ?, ?, ?, ?)`,
				mailboxDrillResultMetaKeys.present,
				mailboxDrillResultMetaKeys.threads,
				mailboxDrillResultMetaKeys.messages,
				mailboxDrillResultMetaKeys.attachments,
				mailboxDrillResultMetaKeys.deliveryEvents,
			)
			.toArray()
		const values = new Map(rows.map((row) => [row.key, Number(row.value)]))
		if (values.get(mailboxDrillResultMetaKeys.present) !== 1) return null
		return {
			threads: values.get(mailboxDrillResultMetaKeys.threads) ?? 0,
			messages: values.get(mailboxDrillResultMetaKeys.messages) ?? 0,
			attachments: values.get(mailboxDrillResultMetaKeys.attachments) ?? 0,
			deliveryEvents:
				values.get(mailboxDrillResultMetaKeys.deliveryEvents) ?? 0,
		}
	}

	completeDrill(ownerId: OwnerId, result: MailboxCountResult): void {
		this.assertOwner(ownerId)
		this.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM email_delivery_events`)
			this.sql.exec(`DELETE FROM email_attachments`)
			this.sql.exec(`DELETE FROM email_message_retention_retries`)
			this.sql.exec(`DELETE FROM email_messages`)
			this.sql.exec(`DELETE FROM email_threads`)
			this.sql.exec(`DELETE FROM email_outbound_provider_index_repairs`)
			this.sql.exec(`DELETE FROM email_message_deletion_tombstones`)
			this.sql.exec(
				`DELETE FROM mailbox_meta WHERE key <> ?`,
				mailboxMetaSchemaVersionKey,
			)
			for (const [key, value] of [
				[mailboxDrillResultMetaKeys.present, 1],
				[mailboxDrillResultMetaKeys.threads, result.threads],
				[mailboxDrillResultMetaKeys.messages, result.messages],
				[mailboxDrillResultMetaKeys.attachments, result.attachments],
				[mailboxDrillResultMetaKeys.deliveryEvents, result.deliveryEvents],
			] as const) {
				this.sql.exec(
					`INSERT INTO mailbox_meta (key, value) VALUES (?, ?)`,
					key,
					value,
				)
			}
		})
	}

	validateMessageBlobKeys(input: {
		ownerId: OwnerId
		message: MailboxMessageInput
		attachments?: Array<MailboxAttachmentInput>
	}) {
		const messageId = assertMailboxNonEmptyString(
			input.message.id,
			'message.id',
		)
		const direction = assertMailboxDirection(input.message.direction)
		const rawMimeKey = input.message.rawMimeKey
		if (direction === 'inbound') {
			const expected = emailRawMimeKey(input.ownerId, messageId)
			if (rawMimeKey !== expected) {
				throw new Error(
					`Mailbox inbound rawMimeKey must equal emailRawMimeKey(ownerId, messageId).`,
				)
			}
		} else if (rawMimeKey != null) {
			const expected = emailRawMimeKey(input.ownerId, messageId)
			if (rawMimeKey !== expected) {
				throw new Error(
					`Mailbox outbound rawMimeKey must be null or equal emailRawMimeKey(ownerId, messageId).`,
				)
			}
		}

		if (input.attachments === undefined) return
		for (const attachment of input.attachments) {
			const attachmentId = assertMailboxNonEmptyString(
				attachment.id,
				'attachment.id',
			)
			const storageKind = assertMailboxStorageKind(attachment.storageKind)
			const storageKey = attachment.storageKey
			if (storageKind === 'external') {
				const expected = emailAttachmentBlobKey(
					input.ownerId,
					messageId,
					attachmentId,
				)
				if (storageKey !== expected) {
					throw new Error(
						`Mailbox external attachment storageKey must equal emailAttachmentBlobKey(ownerId, messageId, attachmentId).`,
					)
				}
			} else if (storageKey != null) {
				throw new Error(
					`Mailbox ${storageKind} attachment storageKey must be null.`,
				)
			}
		}
	}

	upsertThreadRow(thread: MailboxThreadInput): MailboxUpsertResult {
		const id = assertMailboxNonEmptyString(thread.id, 'thread.id')
		const lastMessageAt = assertMailboxCanonicalIsoTimestamp(
			thread.lastMessageAt,
			'thread.lastMessageAt',
		)
		const createdAt = assertMailboxCanonicalIsoTimestamp(
			thread.createdAt,
			'thread.createdAt',
		)
		const updatedAt = assertMailboxCanonicalIsoTimestamp(
			thread.updatedAt,
			'thread.updatedAt',
		)
		const existing = this.sql
			.exec<{ updated_at: string }>(
				`SELECT updated_at FROM email_threads WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		if (existing && updatedAt < existing.updated_at) {
			return { created: false, accepted: false }
		}
		this.sql.exec(
			`INSERT INTO email_threads (
				id, inbox_id, subject_normalized, root_message_id_header,
				last_message_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				inbox_id = excluded.inbox_id,
				subject_normalized = excluded.subject_normalized,
				root_message_id_header = excluded.root_message_id_header,
				last_message_at = excluded.last_message_at,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at >= email_threads.updated_at`,
			id,
			thread.inboxId,
			thread.subjectNormalized,
			thread.rootMessageIdHeader,
			lastMessageAt,
			createdAt,
			updatedAt,
		)
		return { created: existing == null, accepted: true }
	}

	/**
	 * Upsert message metadata. Whole-row updates require equal/newer
	 * `updatedAt`. Delivery status remains monotonic by `delivery_status_at`
	 * within an accepted snapshot.
	 */
	upsertMessageRow(message: MailboxMessageInput): MailboxUpsertResult {
		const id = assertMailboxNonEmptyString(message.id, 'message.id')
		if (this.isMessageTombstoned(id)) {
			return { created: false, accepted: false }
		}
		const direction = assertMailboxDirection(message.direction)
		const processingStatus = assertMailboxProcessingStatus(
			message.processingStatus,
		)
		const classification = assertMailboxClassification(message.classification)
		const deliveryStatus =
			message.deliveryStatus == null
				? null
				: assertMailboxDeliveryStatus(message.deliveryStatus)
		const deliveryStatusAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.deliveryStatusAt,
			'message.deliveryStatusAt',
		)
		if (deliveryStatus != null && deliveryStatusAt == null) {
			throw new Error(
				'Mailbox message.deliveryStatusAt is required when deliveryStatus is set.',
			)
		}
		const createdAt = assertMailboxCanonicalIsoTimestamp(
			message.createdAt,
			'message.createdAt',
		)
		const updatedAt = assertMailboxCanonicalIsoTimestamp(
			message.updatedAt,
			'message.updatedAt',
		)
		const receivedAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.receivedAt,
			'message.receivedAt',
		)
		const sentAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.sentAt,
			'message.sentAt',
		)
		const archivedAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.archivedAt,
			'message.archivedAt',
		)
		const existing = this.sql
			.exec<{ updated_at: string }>(
				`SELECT updated_at FROM email_messages WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		if (existing && updatedAt < existing.updated_at) {
			return { created: false, accepted: false }
		}
		this.sql.exec(
			`INSERT INTO email_messages (
				id, direction, inbox_id, thread_id, sender_identity_id,
				from_address, envelope_from, to_addresses_json, cc_addresses_json,
				bcc_addresses_json, reply_to_addresses_json, subject,
				message_id_header, in_reply_to_header, references_json, headers_json,
				auth_results, text_body, html_body, raw_mime_key, raw_size,
				processing_status, classification, classification_reason,
				provider_message_id, delivery_status, delivery_status_at, error,
				received_at, sent_at, created_at, updated_at, archived_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT(id) DO UPDATE SET
				direction = excluded.direction,
				inbox_id = excluded.inbox_id,
				thread_id = excluded.thread_id,
				sender_identity_id = excluded.sender_identity_id,
				from_address = excluded.from_address,
				envelope_from = excluded.envelope_from,
				to_addresses_json = excluded.to_addresses_json,
				cc_addresses_json = excluded.cc_addresses_json,
				bcc_addresses_json = excluded.bcc_addresses_json,
				reply_to_addresses_json = excluded.reply_to_addresses_json,
				subject = excluded.subject,
				message_id_header = excluded.message_id_header,
				in_reply_to_header = excluded.in_reply_to_header,
				references_json = excluded.references_json,
				headers_json = excluded.headers_json,
				auth_results = excluded.auth_results,
				text_body = excluded.text_body,
				html_body = excluded.html_body,
				raw_mime_key = excluded.raw_mime_key,
				raw_size = excluded.raw_size,
				processing_status = excluded.processing_status,
				classification = excluded.classification,
				classification_reason = excluded.classification_reason,
				archived_at = excluded.archived_at,
				provider_message_id = excluded.provider_message_id,
				delivery_status = CASE
					WHEN excluded.delivery_status_at IS NULL
						THEN email_messages.delivery_status
					WHEN email_messages.delivery_status_at IS NULL
						THEN excluded.delivery_status
					WHEN excluded.delivery_status_at >= email_messages.delivery_status_at
						THEN excluded.delivery_status
					ELSE email_messages.delivery_status
				END,
				delivery_status_at = CASE
					WHEN excluded.delivery_status_at IS NULL
						THEN email_messages.delivery_status_at
					WHEN email_messages.delivery_status_at IS NULL
						THEN excluded.delivery_status_at
					WHEN excluded.delivery_status_at >= email_messages.delivery_status_at
						THEN excluded.delivery_status_at
					ELSE email_messages.delivery_status_at
				END,
				error = excluded.error,
				received_at = excluded.received_at,
				sent_at = excluded.sent_at,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at >= email_messages.updated_at`,
			id,
			direction,
			message.inboxId,
			message.threadId,
			message.senderIdentityId,
			message.fromAddress,
			message.envelopeFrom,
			JSON.stringify(message.toAddresses),
			JSON.stringify(message.ccAddresses),
			JSON.stringify(message.bccAddresses),
			JSON.stringify(message.replyToAddresses),
			message.subject,
			message.messageIdHeader,
			message.inReplyToHeader,
			JSON.stringify(message.references),
			JSON.stringify(message.headers),
			message.authResults,
			boundedEmailBody(message.textBody),
			boundedEmailBody(message.htmlBody),
			message.rawMimeKey,
			message.rawSize,
			processingStatus,
			classification,
			message.classificationReason,
			message.providerMessageId,
			deliveryStatus,
			deliveryStatusAt,
			message.error,
			receivedAt,
			sentAt,
			createdAt,
			updatedAt,
			archivedAt,
		)
		return { created: existing == null, accepted: true }
	}

	replaceAttachmentsForMessage(
		messageId: string,
		attachments: Array<MailboxAttachmentInput>,
	) {
		this.sql.exec(
			`DELETE FROM email_attachments WHERE message_id = ?`,
			messageId,
		)
		for (const attachment of attachments) {
			const id = assertMailboxNonEmptyString(attachment.id, 'attachment.id')
			const attachmentMessageId = assertMailboxNonEmptyString(
				attachment.messageId,
				'attachment.messageId',
			)
			if (attachmentMessageId !== messageId) {
				throw new Error(
					'Mailbox attachment.messageId must match the mirrored message id.',
				)
			}
			const storageKind = assertMailboxStorageKind(attachment.storageKind)
			const createdAt = assertMailboxCanonicalIsoTimestamp(
				attachment.createdAt,
				'attachment.createdAt',
			)
			if (!Number.isFinite(attachment.size)) {
				throw new Error('Mailbox attachment.size must be a finite number.')
			}
			this.sql.exec(
				`INSERT INTO email_attachments (
					id, message_id, filename, content_type, content_id, disposition,
					size, storage_kind, storage_key, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				attachmentMessageId,
				attachment.filename,
				attachment.contentType,
				attachment.contentId,
				attachment.disposition,
				Math.trunc(attachment.size),
				storageKind,
				attachment.storageKey,
				createdAt,
			)
		}
	}

	writeDeliveryEventRow(event: MailboxDeliveryEventInput): {
		inserted: boolean
		accepted: boolean
	} {
		return writeMailboxDeliveryEventRow(this.sql, event)
	}

	updateLatestDeliveryStatus(input: {
		messageId: string
		deliveryStatus: EmailDeliveryStatus
		deliveryStatusAt: string
	}): boolean {
		const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
		const deliveryStatus = assertMailboxDeliveryStatus(input.deliveryStatus)
		const deliveryStatusAt = assertMailboxCanonicalIsoTimestamp(
			input.deliveryStatusAt,
			'deliveryStatusAt',
		)
		const cursor = this.sql.exec(
			`UPDATE email_messages
			SET delivery_status = ?,
				delivery_status_at = ?,
				updated_at = ?
			WHERE id = ?
				AND (delivery_status_at IS NULL OR delivery_status_at <= ?)`,
			deliveryStatus,
			deliveryStatusAt,
			mailboxNowIso(),
			messageId,
			deliveryStatusAt,
		)
		return cursor.rowsWritten > 0
	}

	deliveryEventOwnsMessage(eventId: string, messageId: string) {
		return deliveryEventOwnsMessage(this.sql, eventId, messageId)
	}

	getThread(threadId: string): MailboxThreadRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_threads WHERE id = ? LIMIT 1`,
				assertMailboxNonEmptyString(threadId, 'threadId'),
			)
			.toArray()[0]
		return row ? mapMailboxThreadRow(row) : null
	}

	findThreadForInboundMessage(input: {
		inboxId?: string | null
		references: Array<string>
		inReplyToHeader?: string | null
	}): MailboxThreadRecord | null {
		const headers = [
			...input.references,
			...(input.inReplyToHeader ? [input.inReplyToHeader] : []),
		].filter(Boolean)
		for (const header of headers) {
			const row = this.sql
				.exec<Record<string, SqlStorageValue>>(
					`SELECT thread.*
					FROM email_threads AS thread
					JOIN email_messages AS message ON message.thread_id = thread.id
					WHERE (? IS NULL OR thread.inbox_id = ?)
						AND message.message_id_header = ?
					LIMIT 1`,
					input.inboxId ?? null,
					input.inboxId ?? null,
					header,
				)
				.toArray()[0]
			if (row) return mapMailboxThreadRow(row)
		}
		return null
	}

	getMessage(messageId: string): MailboxMessageRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages WHERE id = ? LIMIT 1`,
				assertMailboxNonEmptyString(messageId, 'messageId'),
			)
			.toArray()[0]
		return row ? mapMailboxMessageRow(row) : null
	}

	getMessageByMessageIdHeader(
		messageIdHeader: string,
	): MailboxMessageRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE message_id_header = ?
				LIMIT 1`,
				assertMailboxNonEmptyString(messageIdHeader, 'messageIdHeader'),
			)
			.toArray()[0]
		return row ? mapMailboxMessageRow(row) : null
	}

	getOutboundMessageByProviderMessageId(
		providerMessageId: string,
	): MailboxMessageRecord | null {
		const id = assertMailboxNonEmptyString(
			providerMessageId,
			'providerMessageId',
		)
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE direction = 'outbound' AND provider_message_id = ?
				LIMIT 2`,
				id,
			)
			.toArray()
		if (rows.length > 1) {
			throw new Error(
				`Multiple outbound email messages share provider id: ${id}`,
			)
		}
		const row = rows[0]
		return row ? mapMailboxMessageRow(row) : null
	}

	/**
	 * Page queries omit `text_body` and `html_body` (each capped at 64 KiB).
	 * SQLite leaves unselected overflow pages unread, and the Durable Object
	 * RPC does not carry them. `getMessage` and the other single-row reads
	 * still return bodies. List and search rows report those fields as null.
	 */
	private queryMessageMetadataPage(input: {
		clauses: Array<string>
		params: Array<SqlStorageValue>
		limit: number
		offset: number
	}): Array<Record<string, SqlStorageValue>> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT ${mailboxMessageMetadataColumns} FROM email_messages
				WHERE ${input.clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ? OFFSET ?`,
				...input.params,
				input.limit,
				input.offset,
			)
			.toArray()
	}

	listMessages(input: MailboxListMessagesInput): {
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	} {
		const limit = normalizeMailboxPageSize(input.limit)
		const { clauses, params } = buildMailboxMessageFilterClauses(input)
		if (input.cursor) {
			const cursor = decodeMailboxListCursor(input.cursor)
			clauses.push('(created_at, id) < (?, ?)')
			params.push(cursor.createdAt, cursor.id)
		}
		const offset =
			input.cursor == null ? normalizeMailboxOffset(input.offset) : 0
		const rows = this.queryMessageMetadataPage({
			clauses,
			params,
			limit: limit + 1,
			offset,
		})
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const last = pageRows[pageRows.length - 1]
		return {
			messages: pageRows.map(mapMailboxMessageRow),
			nextCursor:
				hasMore && last
					? encodeMailboxListCursor({
							createdAt: String(last['created_at']),
							id: String(last['id']),
						})
					: null,
		}
	}

	searchMessages(input: MailboxSearchMessagesInput): {
		messages: Array<MailboxMessageRecord>
	} {
		if (typeof input.query !== 'string') {
			throw new Error('Mailbox search query must be a string.')
		}
		const limit = normalizeMailboxPageSize(input.limit)
		const offset = normalizeMailboxOffset(input.offset)
		const { clauses, params } = buildMailboxMessageFilterClauses({
			...input,
			query: input.query,
		})
		const rows = this.queryMessageMetadataPage({
			clauses,
			params,
			limit,
			offset,
		})
		return { messages: rows.map(mapMailboxMessageRow) }
	}

	countMessages(input: MailboxCountMessagesInput): { total: number } {
		const { clauses, params } = buildMailboxMessageFilterClauses(input)
		const row = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM email_messages
				WHERE ${clauses.join(' AND ')}`,
				...params,
			)
			.one()
		return { total: Number(row.n ?? 0) || 0 }
	}

	getAttachment(attachmentId: string): MailboxAttachmentRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_attachments WHERE id = ? LIMIT 1`,
				assertMailboxNonEmptyString(attachmentId, 'attachmentId'),
			)
			.toArray()[0]
		return row ? mapMailboxAttachmentRow(row) : null
	}

	listAttachmentsForMessage(messageId: string): Array<MailboxAttachmentRecord> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_attachments
				WHERE message_id = ?
				ORDER BY created_at ASC, id ASC`,
				assertMailboxNonEmptyString(messageId, 'messageId'),
			)
			.toArray()
			.map(mapMailboxAttachmentRow)
	}

	listDeliveryEvents(input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}): Array<MailboxDeliveryEventRecord> {
		return listMailboxDeliveryEvents(this.sql, input)
	}

	countMailbox(): MailboxCountResult {
		const threads = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_threads`)
			.one()
		const messages = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_messages`)
			.one()
		const attachments = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_attachments`)
			.one()
		const deliveryEvents = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_delivery_events`)
			.one()
		return {
			threads: Number(threads.n ?? 0) || 0,
			messages: Number(messages.n ?? 0) || 0,
			attachments: Number(attachments.n ?? 0) || 0,
			deliveryEvents: Number(deliveryEvents.n ?? 0) || 0,
		}
	}

	inspectRestoreState(): MailboxRestoreStatus {
		const counts = this.countMailbox()
		const restorePending = this.isRestorePending()
		const hiddenRows = this.sql
			.exec<{ n: number }>(
				`SELECT
					(SELECT COUNT(*) FROM email_message_deletion_tombstones) +
					(SELECT COUNT(*) FROM email_outbound_provider_index_repairs) +
					(SELECT COUNT(*) FROM email_message_retention_retries)
					AS n`,
			)
			.one()
		const hiddenCount = Number(hiddenRows.n ?? 0) || 0
		return {
			counts,
			hiddenRows: hiddenCount,
			restorePending,
			empty:
				!restorePending &&
				hiddenCount === 0 &&
				counts.threads === 0 &&
				counts.messages === 0 &&
				counts.attachments === 0 &&
				counts.deliveryEvents === 0,
		}
	}

	exportMailbox(input: {
		pageSize?: number
		startAfter?: string | null
	}): MailboxExportResult {
		return exportMailboxFromStore(this.sql, input)
	}

	listBlobReferences(input: {
		pageSize?: number
		startAfter?: string | null
	}): MailboxBlobReferencePage {
		return listMailboxBlobReferences(this.sql, {
			ownerId: this.getOwnerId(),
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	oldestMessageCreatedAt(now: string): string | null {
		const row = this.sql
			.exec<{ created_at: string }>(
				`SELECT message.created_at
				FROM email_messages message
				LEFT JOIN email_message_retention_retries retry
					ON retry.message_id = message.id
				WHERE retry.retry_at IS NULL OR retry.retry_at <= ?
				ORDER BY message.created_at ASC, message.id ASC
				LIMIT 1`,
				now,
			)
			.toArray()[0]
		return row?.created_at ?? null
	}

	oldestDeliveryEventCreatedAt(): string | null {
		return oldestMailboxDeliveryEventCreatedAt(this.sql)
	}

	listExpiredMessagesForRetention(input: {
		cutoff: string
		now: string
		limit: number
	}): Array<{
		id: string
		direction: EmailDirection
		created_at: string
		updated_at: string
	}> {
		return this.sql
			.exec<{
				id: string
				direction: EmailDirection
				created_at: string
				updated_at: string
			}>(
				`SELECT message.id, message.direction, message.created_at,
					message.updated_at
				FROM email_messages message
				LEFT JOIN email_message_retention_retries retry
					ON retry.message_id = message.id
				WHERE message.created_at < ?
					AND (retry.retry_at IS NULL OR retry.retry_at <= ?)
				ORDER BY message.created_at ASC, message.id ASC
				LIMIT ?`,
				input.cutoff,
				input.now,
				input.limit,
			)
			.toArray()
	}

	recordMessageRetentionFailure(input: {
		messageId: string
		retryAt: string
		error: string
		updatedAt: string
	}) {
		this.sql.exec(
			`INSERT INTO email_message_retention_retries (
				message_id, retry_at, attempt_count, last_error, updated_at
			) VALUES (?, ?, 1, ?, ?)
			ON CONFLICT(message_id) DO UPDATE SET
				retry_at = excluded.retry_at,
				attempt_count = email_message_retention_retries.attempt_count + 1,
				last_error = excluded.last_error,
				updated_at = excluded.updated_at`,
			input.messageId,
			input.retryAt,
			input.error,
			input.updatedAt,
		)
	}

	earliestMessageRetentionRetryAt(): string | null {
		const row = this.sql
			.exec<{ retry_at: string }>(
				`SELECT retry_at
				FROM email_message_retention_retries
				ORDER BY retry_at ASC, message_id ASC
				LIMIT 1`,
			)
			.toArray()[0]
		return row?.retry_at ?? null
	}

	getMessageForRetention(messageId: string): {
		id: string
		direction: EmailDirection
		created_at: string
		updated_at: string
	} | null {
		return (
			this.sql
				.exec<{
					id: string
					direction: EmailDirection
					created_at: string
					updated_at: string
				}>(
					`SELECT id, direction, created_at, updated_at
					FROM email_messages
					WHERE id = ?
					LIMIT 1`,
					messageId,
				)
				.toArray()[0] ?? null
		)
	}

	listAttachmentsForRetention(
		messageIds: Array<string>,
	): Array<{ id: string; message_id: string; storage_key: string | null }> {
		if (messageIds.length === 0) return []
		return this.sql
			.exec<{
				id: string
				message_id: string
				storage_key: string | null
			}>(
				`SELECT id, message_id, storage_key FROM email_attachments
				WHERE message_id IN (${messageIds.map(() => '?').join(', ')})`,
				...messageIds,
			)
			.toArray()
	}

	deleteMessageCascade(messageId: string) {
		const message = this.sql
			.exec<{ thread_id: string | null }>(
				`SELECT thread_id FROM email_messages WHERE id = ? LIMIT 1`,
				messageId,
			)
			.toArray()[0]
		if (!message) return
		this.sql.exec(
			`UPDATE email_delivery_events SET message_id = NULL
			WHERE message_id = ?`,
			messageId,
		)
		this.sql.exec(
			`DELETE FROM email_attachments WHERE message_id = ?`,
			messageId,
		)
		this.sql.exec(
			`DELETE FROM email_message_retention_retries WHERE message_id = ?`,
			messageId,
		)
		this.sql.exec(`DELETE FROM email_messages WHERE id = ?`, messageId)
		if (message.thread_id != null) {
			this.sql.exec(
				`DELETE FROM email_threads
				WHERE id = ?
					AND NOT EXISTS (
						SELECT 1 FROM email_messages WHERE thread_id = ?
					)`,
				message.thread_id,
				message.thread_id,
			)
		}
	}

	tombstoneAndDeleteMessage(input: { messageId: string; deletedAt: string }) {
		this.storage.transactionSync(() => {
			writeMailboxMessageDeletionTombstone(this.sql, input)
			this.deleteMessageCascade(input.messageId)
		})
	}

	pruneExpiredDeliveryEvents(input: { cutoff: string; limit: number }) {
		pruneExpiredMailboxDeliveryEvents(this.sql, input)
	}

	hasExpiredMessages(cutoff: string): boolean {
		return (
			this.sql
				.exec<{ ok: number }>(
					`SELECT 1 AS ok FROM email_messages
					WHERE created_at < ?
					LIMIT 1`,
					cutoff,
				)
				.toArray()[0] != null
		)
	}

	hasEligibleExpiredMessages(input: { cutoff: string; now: string }): boolean {
		return (
			this.sql
				.exec<{ ok: number }>(
					`SELECT 1 AS ok
					FROM email_messages message
					LEFT JOIN email_message_retention_retries retry
						ON retry.message_id = message.id
					WHERE message.created_at < ?
						AND (retry.retry_at IS NULL OR retry.retry_at <= ?)
					LIMIT 1`,
					input.cutoff,
					input.now,
				)
				.toArray()[0] != null
		)
	}

	hasExpiredDeliveryEvents(cutoff: string): boolean {
		return hasExpiredMailboxDeliveryEvents(this.sql, cutoff)
	}

	pruneOrphanThreads(limit: number) {
		this.sql.exec(
			`DELETE FROM email_threads
			WHERE id IN (
				SELECT thread.id FROM email_threads thread
				WHERE NOT EXISTS (
					SELECT 1 FROM email_messages message
					WHERE message.thread_id = thread.id
				)
				ORDER BY thread.created_at ASC, thread.id ASC
				LIMIT ?
			)`,
			limit,
		)
	}
}
