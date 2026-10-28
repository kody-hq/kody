import {
	boundedEmailBody,
	emailRawMimeKey,
	mapAttachmentRow,
	mapMessageRow,
	mapThreadRow,
	type EmailInboundDeliveryFence,
} from './repo.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	defaultEmailMessageView,
	emailMessageViewSqlClauses,
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailMessageRecord,
	type EmailMessageView,
	type EmailProcessingStatus,
	type EmailThreadRecord,
} from './types.ts'
import {
	assertSystemEmailGraphAuthority,
	commitSystemEmailAuthorityBatch,
} from './system-email-authority.ts'
import {
	systemEmailAttachmentColumns,
	systemEmailMessageColumns,
	systemEmailThreadColumns,
} from './system-email-graph-columns.ts'
import {
	systemInboundDedupeProvider,
	systemInboundDedupeTombstoneStatements,
	systemInboundProvider,
} from './system-inbound-dedupe.ts'

type DeleteSystemEmailMessageByIdResult = {
	messageFound: boolean
	ownerUserId: string | null
	attachmentsSeen: number
	externalAttachmentsSeen: number
	blobDeletions: Array<{
		key: string
		role: 'raw_mime' | 'attachment'
		deleted: boolean
	}>
}

function nowIso() {
	return new Date().toISOString()
}

function messageSelect(columns = 'message.*') {
	return `SELECT ${columns}, '${systemEmailOwnerId}' AS user_id
		FROM system_email_messages AS message`
}

function threadRecord(row: Record<string, unknown>): EmailThreadRecord {
	return mapThreadRow({ ...row, user_id: systemEmailOwnerId })
}

function messageRecord(row: Record<string, unknown>): EmailMessageRecord {
	return mapMessageRow({ ...row, user_id: systemEmailOwnerId })
}

export async function getSystemEmailMessageById(input: {
	db: D1Database
	messageId: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`${messageSelect()}
			WHERE message.id = ?
			LIMIT 1`,
		)
		.bind(input.messageId)
		.first<Record<string, unknown>>()
	return row ? messageRecord(row) : null
}

export async function countSystemEmailMessages(input: {
	db: D1Database
	direction?: 'inbound' | 'outbound'
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM system_email_messages
			WHERE (? IS NULL OR direction = ?)`,
		)
		.bind(input.direction ?? null, input.direction ?? null)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function listSystemEmailMessages(input: {
	db: D1Database
	inboxId?: string | null
	classification?: EmailClassification | null
	limit: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const result = await input.db
		.prepare(
			`${messageSelect()}
			WHERE (? IS NULL OR message.inbox_id = ?)
				AND (? IS NULL OR message.classification = ?)
			ORDER BY message.created_at DESC, message.id DESC
			LIMIT ?`,
		)
		.bind(
			input.inboxId ?? null,
			input.inboxId ?? null,
			input.classification ?? null,
			input.classification ?? null,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(messageRecord)
}

export async function findSystemEmailThreadForInboundMessage(input: {
	db: D1Database
	inboxId?: string | null
	references: Array<string>
	inReplyToHeader?: string | null
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const ids = [
		...input.references,
		...(input.inReplyToHeader ? [input.inReplyToHeader] : []),
	].filter(Boolean)
	for (const id of ids) {
		const row = await input.db
			.prepare(
				`SELECT thread.*, '${systemEmailOwnerId}' AS user_id
				FROM system_email_threads thread
				JOIN system_email_messages message ON message.thread_id = thread.id
				WHERE (? IS NULL OR thread.inbox_id = ?)
					AND message.message_id_header = ?
				LIMIT 1`,
			)
			.bind(input.inboxId ?? null, input.inboxId ?? null, id)
			.first<Record<string, unknown>>()
		if (row) return threadRecord(row)
	}
	return null
}

export async function createSystemEmailThread(input: {
	db: D1Database
	id?: string
	inboxId?: string | null
	subjectNormalized?: string | null
	rootMessageIdHeader?: string | null
	lastMessageAt?: string | null
	ignoreConflict?: boolean
	inboundDeliveryFence?: SystemInboundDeliveryFence
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const timestamp = nowIso()
	const row = {
		id: input.id ?? crypto.randomUUID(),
		inbox_id: input.inboxId ?? null,
		subject_normalized: input.subjectNormalized ?? '',
		root_message_id_header: input.rootMessageIdHeader ?? null,
		last_message_at: input.lastMessageAt ?? timestamp,
		created_at: timestamp,
		updated_at: timestamp,
	}
	const values = [
		row.id,
		row.inbox_id,
		row.subject_normalized,
		row.root_message_id_header,
		row.last_message_at,
		row.created_at,
		row.updated_at,
	]
	const fence = input.inboundDeliveryFence
	const prefix = input.ignoreConflict ? 'INSERT OR IGNORE' : 'INSERT'
	const placeholders = systemEmailThreadColumns.map(() => '?').join(', ')
	const ownerFence = `(? IS NULL OR EXISTS (
		SELECT 1 FROM email_inboxes
		WHERE id = ? AND user_id = ?
	))`
	const dedicated = input.db
		.prepare(
			`${prefix} INTO system_email_threads (
				${systemEmailThreadColumns.join(', ')}
			) SELECT ${placeholders}
			WHERE ${ownerFence}
				AND ${fence ? systemInboundDeliveryFenceSql() : '1'}`,
		)
		.bind(
			...values,
			row.inbox_id,
			row.inbox_id,
			systemEmailOwnerId,
			...(fence ? systemInboundDeliveryFenceBinds(fence) : []),
		)
	const [insertResult] = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements: [dedicated],
	})
	if (Number(insertResult?.meta.changes ?? 0) === 0) {
		if (input.ignoreConflict) {
			const existing = await input.db
				.prepare(
					`SELECT *, '${systemEmailOwnerId}' AS user_id
					FROM system_email_threads
					WHERE id = ?
					LIMIT 1`,
				)
				.bind(row.id)
				.first<Record<string, unknown>>()
			if (existing) return threadRecord(existing)
		}
		throw new Error(
			'System email thread insert rejected an invalid operator-owned inbox reference.',
		)
	}
	return threadRecord(row)
}

type SystemInboundDeliveryFence = Omit<EmailInboundDeliveryFence, 'userId'>

/** Delivery-event fence that also refuses a rejected inbound fingerprint pointer. */
function systemInboundDeliveryFenceSql() {
	return `EXISTS (
		SELECT 1 FROM system_email_delivery_events
		WHERE id = ? AND state = 'storing' AND storage_lease = ?
			AND NOT EXISTS (
				SELECT 1 FROM system_email_delivery_events AS pointer
				WHERE pointer.provider = ?
					AND pointer.state = 'rejected'
					AND pointer.id = (
						'email-inbound-dedupe:' ||
						system_email_delivery_events.fingerprint
					)
					AND json_extract(pointer.detail_json, '$.messageId') =
						json_extract(
							system_email_delivery_events.detail_json, '$.messageId'
						)
			)
	)`
}

function systemInboundDeliveryFenceBinds(fence: SystemInboundDeliveryFence) {
	return [fence.deliveryId, fence.storageLease, systemInboundDedupeProvider]
}

type SystemInboundMessageInput = {
	id?: string
	inboxId?: string | null
	threadId?: string | null
	senderIdentityId?: string | null
	fromAddress?: string | null
	envelopeFrom?: string | null
	toAddresses?: Array<unknown>
	ccAddresses?: Array<unknown>
	bccAddresses?: Array<unknown>
	replyToAddresses?: Array<unknown>
	subject?: string | null
	messageIdHeader?: string | null
	inReplyToHeader?: string | null
	references?: Array<string>
	headers?: Record<string, unknown> | null
	authResults?: string | null
	textBody?: string | null
	htmlBody?: string | null
	rawMimeKey?: string | null
	rawSize?: number | null
	processingStatus: EmailProcessingStatus
	classification?: EmailClassification
	classificationReason?: string | null
	error?: string | null
	receivedAt?: string | null
	sentAt?: string | null
}

export async function insertSystemEmailMessage(input: {
	db: D1Database
	inboundDeliveryFence?: SystemInboundDeliveryFence
	message: SystemInboundMessageInput
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const timestamp = nowIso()
	const row = {
		id: input.message.id ?? crypto.randomUUID(),
		direction: 'inbound' as const,
		inbox_id: input.message.inboxId ?? null,
		thread_id: input.message.threadId ?? null,
		sender_identity_id: input.message.senderIdentityId ?? null,
		from_address: input.message.fromAddress ?? '',
		envelope_from: input.message.envelopeFrom ?? null,
		to_addresses_json: JSON.stringify(input.message.toAddresses ?? []),
		cc_addresses_json: JSON.stringify(input.message.ccAddresses ?? []),
		bcc_addresses_json: JSON.stringify(input.message.bccAddresses ?? []),
		reply_to_addresses_json: JSON.stringify(
			input.message.replyToAddresses ?? [],
		),
		subject: input.message.subject ?? '',
		message_id_header: input.message.messageIdHeader ?? null,
		in_reply_to_header: input.message.inReplyToHeader ?? null,
		references_json: JSON.stringify(input.message.references ?? []),
		headers_json: input.message.headers
			? JSON.stringify(input.message.headers)
			: '{}',
		auth_results: input.message.authResults ?? null,
		text_body: boundedEmailBody(input.message.textBody),
		html_body: boundedEmailBody(input.message.htmlBody),
		raw_size: input.message.rawSize ?? 0,
		processing_status: input.message.processingStatus,
		provider_message_id: null,
		error: input.message.error ?? null,
		received_at: input.message.receivedAt ?? null,
		sent_at: input.message.sentAt ?? null,
		created_at: timestamp,
		updated_at: timestamp,
		raw_mime_key: input.message.rawMimeKey ?? null,
		delivery_status: null,
		delivery_status_at: null,
		classification: input.message.classification ?? 'accepted',
		classification_reason: input.message.classificationReason ?? null,
		archived_at: null,
	}
	const columns = systemEmailMessageColumns
	const values = columns.map((column) => row[column])
	const placeholders = columns.map(() => '?').join(', ')
	const fence = input.inboundDeliveryFence
	const deliveryFenceSql = fence ? systemInboundDeliveryFenceSql() : '1'
	const sharedReferenceFenceSql = `(? IS NULL OR EXISTS (
			SELECT 1 FROM email_inboxes WHERE id = ? AND user_id = ?
		))
		AND (? IS NULL OR EXISTS (
			SELECT 1 FROM email_sender_identities WHERE id = ? AND user_id = ?
		))`
	const sharedReferenceValues = [
		row.inbox_id,
		row.inbox_id,
		systemEmailOwnerId,
		row.sender_identity_id,
		row.sender_identity_id,
		systemEmailOwnerId,
	]
	const dedicated = input.db
		.prepare(
			`INSERT INTO system_email_messages (${columns.join(', ')})
			SELECT ${placeholders}
			WHERE ${sharedReferenceFenceSql}
				AND (? IS NULL OR EXISTS (
					SELECT 1 FROM system_email_threads WHERE id = ?
				))
				AND ${deliveryFenceSql}`,
		)
		.bind(
			...values,
			...sharedReferenceValues,
			row.thread_id,
			row.thread_id,
			...(fence ? systemInboundDeliveryFenceBinds(fence) : []),
		)
	const [insertResult] = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements: [dedicated],
	})
	if (Number(insertResult?.meta.changes ?? 0) === 0) {
		if (fence) {
			throw new Error(
				'Inbound delivery storage lease was lost before system message insert.',
			)
		}
		throw new Error(
			'System email message insert rejected an invalid dedicated reference.',
		)
	}
	return messageRecord(row)
}

export async function insertSystemEmailAttachments(input: {
	db: D1Database
	messageId: string
	ignoreConflicts?: boolean
	inboundDeliveryFence?: SystemInboundDeliveryFence
	attachments: Array<{
		id?: string | null
		filename?: string | null
		contentType?: string | null
		contentId?: string | null
		disposition?: string | null
		size?: number | null
		storageKind: string
		storageKey?: string | null
	}>
}) {
	await assertSystemEmailGraphAuthority(input.db)
	if (input.attachments.length === 0) return
	const timestamp = nowIso()
	const prefix = input.ignoreConflicts ? 'INSERT OR IGNORE' : 'INSERT'
	const fence = input.inboundDeliveryFence
	const deliveryFenceSql = fence ? systemInboundDeliveryFenceSql() : '1'
	const statements: Array<D1PreparedStatement> = []
	const attachmentIds: Array<string> = []
	for (const attachment of input.attachments) {
		const attachmentId = attachment.id ?? crypto.randomUUID()
		attachmentIds.push(attachmentId)
		const values = [
			attachmentId,
			input.messageId,
			attachment.filename ?? null,
			attachment.contentType ?? null,
			attachment.contentId ?? null,
			attachment.disposition ?? null,
			attachment.size ?? 0,
			attachment.storageKind,
			attachment.storageKey ?? null,
			timestamp,
		]
		const dedicated = input.db
			.prepare(
				`${prefix} INTO system_email_attachments (
						${systemEmailAttachmentColumns.join(', ')}
					) SELECT ${systemEmailAttachmentColumns.map(() => '?').join(', ')}
					WHERE EXISTS (
						SELECT 1 FROM system_email_messages WHERE id = ?
					) AND ${deliveryFenceSql}`,
			)
			.bind(
				...values,
				input.messageId,
				...(fence ? systemInboundDeliveryFenceBinds(fence) : []),
			)
		statements.push(dedicated)
	}
	const results = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements,
	})
	for (const [index, result] of results.entries()) {
		if (Number(result?.meta.changes ?? 0) > 0) continue
		const existing = await input.db
			.prepare(
				`SELECT message_id FROM system_email_attachments
				WHERE id = ? LIMIT 1`,
			)
			.bind(attachmentIds[index])
			.first<{ message_id: string }>()
		if (input.ignoreConflicts && existing?.message_id === input.messageId) {
			if (!fence) continue
			const currentFence = await input.db
				.prepare(
					`SELECT 1 AS present FROM system_email_delivery_events
					WHERE id = ? AND state = 'storing' AND storage_lease = ?
					LIMIT 1`,
				)
				.bind(fence.deliveryId, fence.storageLease)
				.first<{ present: number }>()
			if (currentFence) continue
		}
		if (fence) {
			throw new Error(
				'Inbound delivery storage lease was lost before system attachment insert.',
			)
		}
		throw new Error(
			'System email attachment insert rejected an invalid dedicated reference.',
		)
	}
}

export async function listSystemEmailAttachments(input: {
	db: D1Database
	messageId: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const result = await input.db
		.prepare(
			`SELECT *
			FROM system_email_attachments
			WHERE message_id = ?
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(input.messageId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapAttachmentRow)
}

export async function getSystemEmailAttachmentById(input: {
	db: D1Database
	attachmentId: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT attachment.*
			FROM system_email_attachments attachment
			WHERE attachment.id = ?
			LIMIT 1`,
		)
		.bind(input.attachmentId)
		.first<Record<string, unknown>>()
	return row ? mapAttachmentRow(row) : null
}

export async function touchSystemEmailThread(input: {
	db: D1Database
	threadId: string
	lastMessageAt?: string | null
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const updatedAt = nowIso()
	const lastMessageAt = input.lastMessageAt ?? updatedAt
	const dedicated = input.db
		.prepare(
			`UPDATE system_email_threads
				SET last_message_at = ?, updated_at = ?
				WHERE id = ?`,
		)
		.bind(lastMessageAt, updatedAt, input.threadId)
	await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements: [dedicated],
	})
}

export async function updateSystemEmailMessageClassification(input: {
	db: D1Database
	messageId: string
	classification?: EmailClassification
	classificationReason?: string | null
	/** `true` stamps `archived_at`, `false` clears it, omitted keeps it. */
	archived?: boolean
	now?: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const updatedAt = input.now ?? nowIso()
	const assignments: Array<string> = []
	const values: Array<string | null> = []
	if (input.classification !== undefined) {
		assignments.push('classification = ?', 'classification_reason = ?')
		values.push(input.classification, input.classificationReason ?? null)
	}
	if (input.archived !== undefined) {
		assignments.push('archived_at = ?')
		values.push(input.archived ? updatedAt : null)
	}
	if (assignments.length === 0) {
		throw new Error(
			'System email message update requires classification or archived.',
		)
	}
	const dedicated = input.db
		.prepare(
			`UPDATE system_email_messages
				SET ${assignments.join(', ')}, updated_at = ?
				WHERE id = ? AND direction = 'inbound'`,
		)
		.bind(...values, updatedAt, input.messageId)
	const [updateResult] = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements: [dedicated],
	})
	return Number(updateResult?.meta.changes ?? 0) > 0
}

export async function deleteEmptySystemEmailThreads(input: {
	db: D1Database
	before: string
	limit: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const rows = await input.db
		.prepare(
			`SELECT thread.id
			FROM system_email_threads thread
			WHERE thread.created_at < ?
				AND NOT EXISTS (
					SELECT 1 FROM system_email_messages message
					WHERE message.thread_id = thread.id
				)
			ORDER BY thread.created_at ASC, thread.id ASC
			LIMIT ?`,
		)
		.bind(input.before, input.limit)
		.all<{ id: string }>()
	const ids = (rows.results ?? []).map((row) => row.id)
	if (ids.length === 0) return 0
	const statements = ids.map((id) =>
		input.db
			.prepare(
				`DELETE FROM system_email_threads
				WHERE id = ? AND NOT EXISTS (
					SELECT 1 FROM system_email_messages WHERE thread_id = ?
				)`,
			)
			.bind(id, id),
	)
	const results = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements,
	})
	return results.reduce(
		(total, result) => total + Number(result?.meta.changes ?? 0),
		0,
	)
}

export async function deleteSystemEmailMessageById(input: {
	db: D1Database
	blobs: R2Bucket
	messageId: string
}): Promise<DeleteSystemEmailMessageByIdResult> {
	const message = await getSystemEmailMessageById(input)
	if (!message) {
		return {
			messageFound: false,
			ownerUserId: null,
			attachmentsSeen: 0,
			externalAttachmentsSeen: 0,
			blobDeletions: [],
		}
	}
	const attachments = await listSystemEmailAttachments(input)
	// Linked rows (any provider) plus unlinked system-inbound charged events
	// (message_id still NULL until markSystemInboundDeliveryReceived). Dedupe
	// pointers stay for tombstoning.
	const deliveryEvents = await input.db
		.prepare(
			`SELECT id FROM system_email_delivery_events
			WHERE message_id = ?
				OR (
					provider = ?
					AND json_extract(detail_json, '$.messageId') = ?
				)`,
		)
		.bind(input.messageId, systemInboundProvider, input.messageId)
		.all<{ id: string }>()
	const inventory = [
		{
			key: emailRawMimeKey(systemEmailOwnerId, input.messageId),
			role: 'raw_mime' as const,
		},
		...attachments.flatMap((attachment) =>
			attachment.storageKey
				? [{ key: attachment.storageKey, role: 'attachment' as const }]
				: [],
		),
	]
	const blobDeletions: DeleteSystemEmailMessageByIdResult['blobDeletions'] = []
	for (const entry of inventory) {
		try {
			await input.blobs.delete(entry.key)
			blobDeletions.push({ ...entry, deleted: true })
		} catch (error) {
			console.warn('email-blob-delete-failed', entry.key, error)
			blobDeletions.push({ ...entry, deleted: false })
		}
	}
	if (blobDeletions.some((entry) => !entry.deleted)) {
		throw new Error(
			'System email blob deletion failed before authoritative row delete.',
		)
	}
	const tombstones = await systemInboundDedupeTombstoneStatements({
		db: input.db,
		messageIds: [input.messageId],
	})
	const statements: Array<D1PreparedStatement> = [
		...tombstones,
		...attachments.map((attachment) =>
			input.db
				.prepare(`DELETE FROM system_email_attachments WHERE id = ?`)
				.bind(attachment.id),
		),
		...(deliveryEvents.results ?? []).map((event) =>
			input.db
				.prepare(`DELETE FROM system_email_delivery_events WHERE id = ?`)
				.bind(event.id),
		),
		input.db
			.prepare(`DELETE FROM system_email_messages WHERE id = ?`)
			.bind(input.messageId),
	]
	// Drop the thread when this was its last message so admin deletes leave no
	// orphan graph rows (retention would eventually prune them otherwise).
	if (message.threadId) {
		statements.push(
			input.db
				.prepare(
					`DELETE FROM system_email_threads
					WHERE id = ? AND NOT EXISTS (
						SELECT 1 FROM system_email_messages WHERE thread_id = ?
					)`,
				)
				.bind(message.threadId, message.threadId),
		)
	}
	await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements,
	})
	return {
		messageFound: true,
		ownerUserId: systemEmailOwnerId,
		attachmentsSeen: attachments.length,
		externalAttachmentsSeen: attachments.filter(
			(attachment) => attachment.storageKind === 'external',
		).length,
		blobDeletions,
	}
}

export type SystemEmailAdminListRow = Record<string, unknown>

/**
 * Resolve the admin "Inbox" label from `email_inboxes.name`.
 *
 * Do not join `email_inbox_addresses` here. One operator inbox can have
 * several address rows — one per accepted system domain (canonical plus
 * `LEGACY_SYSTEM_EMAIL_DOMAINS`) — all with the same local part. That join
 * fans the list out (three identical rows per message in production).
 */
const adminSystemInboxJoin = `LEFT JOIN email_inboxes AS inbox
	ON inbox.id = message.inbox_id
	AND inbox.user_id = ?`

export async function listSystemEmailAdminMessages(input: {
	db: D1Database
	pageSize: number
	offset: number
	/** Defaults to `inbox` (hides spam and archived mail). */
	view?: EmailMessageView
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const where = [
		`message.direction = 'inbound'`,
		...emailMessageViewSqlClauses(
			input.view ?? defaultEmailMessageView,
			'message.',
		),
	].join(' AND ')
	const [total, rows] = await Promise.all([
		input.db
			.prepare(
				`SELECT COUNT(*) AS total
				FROM system_email_messages AS message
				WHERE ${where}`,
			)
			.first<{ total: number }>(),
		input.db
			.prepare(
				`SELECT message.id, inbox.name AS inbox_local_part,
					message.from_address, message.envelope_from, message.subject,
					message.processing_status, message.raw_size, message.received_at,
					message.created_at, message.to_addresses_json,
					message.classification, message.classification_reason,
					message.archived_at
				FROM system_email_messages AS message
				${adminSystemInboxJoin}
				WHERE ${where}
				ORDER BY message.created_at DESC, message.id DESC
				LIMIT ? OFFSET ?`,
			)
			.bind(systemEmailOwnerId, input.pageSize, input.offset)
			.all<SystemEmailAdminListRow>(),
	])
	return {
		total: Number(total?.total ?? 0),
		rows: rows.results ?? [],
	}
}

export async function getSystemEmailAdminMessageRow(input: {
	db: D1Database
	messageId: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	return await input.db
		.prepare(
			`SELECT message.*, inbox.name AS inbox_local_part
			FROM system_email_messages AS message
			${adminSystemInboxJoin}
			WHERE message.id = ?
			LIMIT 1`,
		)
		.bind(systemEmailOwnerId, input.messageId)
		.first<Record<string, unknown>>()
}

export function systemEmailAttachmentRecords(
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<EmailAttachmentRecord> {
	return rows.map(mapAttachmentRow)
}
