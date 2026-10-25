import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	maxRestorableTextColumnBytes,
	truncateToUtf8Bytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { parseJsonArray } from '@kody-internal/shared/json-parsing.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	emailClassificationValues,
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailDeliveryEventRecord,
	type EmailDirection,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailInboxAddressRecord,
	type EmailInboxRecord,
	type EmailMessageRecord,
	type EmailProcessingStatus,
	type EmailSenderIdentityRecord,
	type EmailThreadRecord,
} from './types.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
function nowIso() {
	return new Date().toISOString()
}

export const emailBodyTruncationNotice =
	'\n[truncated for backup-safe storage; the full message is retained in the raw MIME object]'

/**
 * Bound stored email body columns so a full `email_messages` row stays
 * below D1's import statement limit (oversized rows make D1 backups
 * un-importable). The canonical full message remains in the R2 raw MIME
 * object referenced by `raw_mime_key`.
 */
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

export type EmailInboundDeliveryFence = {
	deliveryId: string
	userId: string
	storageLease: string
}

export { emailAttachmentBlobKey, emailRawMimeKey }

// One corrupt stored row must not fail an entire list/search response, so
// the record parser degrades to an empty shape on malformed JSON.
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

function mapInboxRow(row: Record<string, unknown>): EmailInboxRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		name: String(row['name']),
		description: row['description'] == null ? '' : String(row['description']),
		enabled: Number(row['enabled']) === 1,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapInboxAddressRow(
	row: Record<string, unknown>,
): EmailInboxAddressRecord {
	return {
		id: String(row['id']),
		inboxId: String(row['inbox_id']),
		userId: String(row['user_id']),
		address: String(row['address']),
		localPart: String(row['local_part']),
		domain: String(row['domain']),
		enabled: Number(row['enabled']) === 1,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export function mapThreadRow(row: Record<string, unknown>): EmailThreadRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
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

function mapClassification(value: unknown): EmailClassification {
	if (value == null) return 'accepted'
	const classification = String(value)
	return (emailClassificationValues as ReadonlyArray<string>).includes(
		classification,
	)
		? (classification as EmailClassification)
		: 'accepted'
}

export function mapMessageRow(
	row: Record<string, unknown>,
): EmailMessageRecord {
	return {
		id: String(row['id']),
		direction: String(row['direction']) as EmailDirection,
		userId: String(row['user_id']) as OwnerId,
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
		toAddresses: parseJsonArray(
			String(row['to_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		ccAddresses: parseJsonArray(
			String(row['cc_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		bccAddresses: parseJsonArray(
			String(row['bcc_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		replyToAddresses: parseJsonArray(
			String(row['reply_to_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		subject: row['subject'] == null ? null : String(row['subject']),
		messageIdHeader:
			row['message_id_header'] == null
				? null
				: String(row['message_id_header']),
		inReplyToHeader:
			row['in_reply_to_header'] == null
				? null
				: String(row['in_reply_to_header']),
		references: parseJsonArray(String(row['references_json'] ?? '[]')).filter(
			(value): value is string => typeof value === 'string',
		),
		headers: parseOptionalJsonRecord(
			row['headers_json'] == null ? null : String(row['headers_json']),
		),
		authResults:
			row['auth_results'] == null ? null : String(row['auth_results']),
		textBody: row['text_body'] == null ? null : String(row['text_body']),
		htmlBody: row['html_body'] == null ? null : String(row['html_body']),
		rawMimeKey:
			row['raw_mime_key'] == null ? null : String(row['raw_mime_key']),
		rawSize: row['raw_size'] == null ? null : Number(row['raw_size']),
		processingStatus: String(row['processing_status']) as EmailProcessingStatus,
		classification: mapClassification(row['classification']),
		classificationReason:
			row['classification_reason'] == null
				? null
				: String(row['classification_reason']),
		archivedAt: row['archived_at'] == null ? null : String(row['archived_at']),
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		deliveryStatus:
			row['delivery_status'] == null
				? null
				: (String(row['delivery_status']) as EmailDeliveryStatus),
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

export function mapDeliveryEventRow(
	row: Record<string, unknown>,
): EmailDeliveryEventRecord {
	return {
		id: String(row['id']),
		messageId: row['message_id'] == null ? null : String(row['message_id']),
		userId: row['user_id'] == null ? null : String(row['user_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		eventType: String(row['event_type']) as EmailDeliveryEventType,
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
		createdAt: String(row['created_at']),
	}
}

export function mapAttachmentRow(
	row: Record<string, unknown>,
): EmailAttachmentRecord {
	return {
		id: String(row['id']),
		messageId: String(row['message_id']),
		filename: row['filename'] == null ? null : String(row['filename']),
		contentType:
			row['content_type'] == null ? null : String(row['content_type']),
		contentId: row['content_id'] == null ? null : String(row['content_id']),
		disposition: row['disposition'] == null ? null : String(row['disposition']),
		size: Number(row['size'] ?? 0),
		storageKind: String(row['storage_kind']),
		storageKey: row['storage_key'] == null ? null : String(row['storage_key']),
		createdAt: String(row['created_at']),
	}
}

export async function createEmailInbox(input: {
	db: D1Database
	userId: string
	name: string
	description?: string | null
	packageId?: string | null
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		package_id: input.packageId ?? null,
		name: input.name,
		description: input.description ?? null,
		enabled: 1,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, package_id, name, description, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.package_id,
			row.name,
			row.description,
			row.enabled,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapInboxRow(row)
}

export async function deleteEmailInboxAddressById(input: {
	db: D1Database
	addressId: string
}) {
	await input.db
		.prepare(
			`DELETE FROM email_inbox_addresses WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.addressId)
		.run()
}

export async function createEmailInboxAddress(input: {
	db: D1Database
	inboxId: string
	userId: string
	address: string
	localPart: string
	domain: string
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		inbox_id: input.inboxId,
		user_id: input.userId,
		address: input.address,
		local_part: input.localPart,
		domain: input.domain,
		enabled: 1,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_inbox_addresses (
				id, inbox_id, user_id, address, local_part, domain, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.inbox_id,
			row.user_id,
			row.address,
			row.local_part,
			row.domain,
			row.enabled,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapInboxAddressRow(row)
}

export async function listEmailInboxesForUser(input: {
	db: D1Database
	userId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_inboxes
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY created_at DESC, id DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapInboxRow)
}

export async function listEmailInboxAddressesForUser(input: {
	db: D1Database
	userId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_inbox_addresses
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY created_at DESC, id DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapInboxAddressRow)
}

/**
 * Read the row holding a (globally unique) address regardless of its
 * enabled state, so callers can distinguish "address free" from "address
 * held but disabled" instead of tripping the unique constraint.
 */
export async function getEmailInboxAddressByAddress(input: {
	db: D1Database
	address: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inbox_addresses
			WHERE address = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.address)
		.first<Record<string, unknown>>()
	return row ? mapInboxAddressRow(row) : null
}

export async function getEmailInboxById(input: {
	db: D1Database
	userId?: string
	id: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inboxes
			WHERE id = ?
				AND (? IS NULL OR user_id = ?)
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.id, input.userId ?? null, input.userId ?? null)
		.first<Record<string, unknown>>()
	return row ? mapInboxRow(row) : null
}

export async function getEmailInboxByName(input: {
	db: D1Database
	userId: string
	name: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inboxes
			WHERE user_id = ?
				AND name = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<Record<string, unknown>>()
	return row ? mapInboxRow(row) : null
}

function mapSenderIdentityRow(
	row: Record<string, unknown>,
): EmailSenderIdentityRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		email: String(row['email']),
		domain: String(row['domain']),
		status: String(row['status']) as EmailSenderIdentityRecord['status'],
		verifiedAt: row['verified_at'] == null ? null : String(row['verified_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

async function getSenderIdentityByEmail(input: {
	db: D1Database
	userId: string
	email: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_identities
			WHERE user_id = ?
				AND email = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.email)
		.first<Record<string, unknown>>()
	return row ? mapSenderIdentityRow(row) : null
}

/**
 * Ensure the platform-assigned sender identity row
 * (`{username}@<platform domain>`, status `verified`) exists for the user.
 * Platform provisioning is the only writer; identities are always verified.
 * Race-tolerant with signup / first-inbound concurrency via ON CONFLICT.
 */
export async function ensurePlatformSenderIdentity(input: {
	db: D1Database
	userId: string
	email: string
	domain: string
}): Promise<EmailSenderIdentityRecord> {
	const existing = await getSenderIdentityByEmail(input)
	if (existing) return existing
	const timestamp = nowIso()
	await input.db
		.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, domain, status, verified_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)
			ON CONFLICT(user_id, email) DO UPDATE SET
				domain = excluded.domain,
				updated_at = excluded.updated_at`,
		)
		.bind(
			crypto.randomUUID(),
			input.userId,
			input.email,
			input.domain,
			timestamp,
			timestamp,
			timestamp,
		)
		.run()
	const persisted = await getSenderIdentityByEmail(input)
	if (!persisted) {
		throw new Error('Failed to provision the platform sender identity.')
	}
	return persisted
}
