import {
	parseJsonStringArray,
	parseJsonWithFallback,
} from '@kody-internal/shared/json-parsing.ts'
import { readPagination } from '#worker/query-params.ts'
// Type-only: see the note in users-data.ts.
import { type AdminSystemEmailLoaderData } from '#universal/loader-data.ts'
import { loadRawMime } from '#worker/email/service.ts'
import {
	getSystemEmailAdminMessageRow,
	listSystemEmailAdminMessages,
	listSystemEmailAttachments,
} from '#worker/email/system-email-graph-store.ts'
import {
	systemEmailLimits,
	systemEmailLocals,
	systemEmailOwnerId,
} from '#worker/email/system-email.ts'

export const adminSystemEmailListItemFieldNames = [
	'id',
	'inbox_local_part',
	'from_address',
	'envelope_from',
	'subject',
	'processing_status',
	'raw_size',
	'received_at',
	'created_at',
	'to_addresses',
] as const

type AdminSystemEmailListItemFieldName =
	(typeof adminSystemEmailListItemFieldNames)[number]

export type AdminSystemEmailListItem = Record<
	AdminSystemEmailListItemFieldName,
	unknown
> & {
	id: string
	inbox_local_part: string
	from_address: string | null
	envelope_from: string | null
	subject: string | null
	processing_status: string
	raw_size: number
	received_at: string | null
	created_at: string
	to_addresses: Array<string>
}

export type AdminSystemEmailDetail = AdminSystemEmailListItem & {
	cc_addresses: Array<string>
	reply_to_addresses: Array<string>
	headers: Record<string, Array<string>>
	text_body: string | null
	html_body: string | null
	raw_mime: string | null
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		created_at: string
	}>
}

const defaultPageSize = 25
const maxPageSize = 100

function parseHeaders(value: string | null): Record<string, Array<string>> {
	if (!value) return {}
	const parsed = parseJsonWithFallback<unknown>(value, null)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
	const headers: Record<string, Array<string>> = {}
	for (const [key, headerValue] of Object.entries(parsed)) {
		if (!Array.isArray(headerValue)) continue
		headers[key] = headerValue.filter(
			(entry): entry is string => typeof entry === 'string',
		)
	}
	return headers
}

function toListItem(row: Record<string, unknown>): AdminSystemEmailListItem {
	return {
		id: String(row['id']),
		inbox_local_part: String(row['inbox_local_part'] ?? ''),
		from_address:
			row['from_address'] == null ? null : String(row['from_address']),
		envelope_from:
			row['envelope_from'] == null ? null : String(row['envelope_from']),
		subject: row['subject'] == null ? null : String(row['subject']),
		processing_status: String(row['processing_status']),
		raw_size: Number(row['raw_size'] ?? 0),
		received_at: row['received_at'] == null ? null : String(row['received_at']),
		created_at: String(row['created_at']),
		to_addresses: parseJsonStringArray(
			row['to_addresses_json'] == null
				? null
				: String(row['to_addresses_json']),
		),
	}
}

async function listAttachments(db: D1Database, messageId: string) {
	const attachments = await listSystemEmailAttachments({ db, messageId })
	return attachments.map((attachment) => ({
		id: attachment.id,
		filename: attachment.filename,
		content_type: attachment.contentType,
		content_id: attachment.contentId,
		disposition: attachment.disposition,
		size: attachment.size,
		storage_kind: attachment.storageKind,
		created_at: attachment.createdAt,
	}))
}

export async function loadAdminSystemEmailMessageById(
	db: D1Database,
	messageId: string,
	blobs: R2Bucket,
): Promise<AdminSystemEmailDetail | null> {
	const row = await getSystemEmailAdminMessageRow({ db, messageId })
	if (!row) return null
	return {
		...toListItem(row),
		to_addresses: parseJsonStringArray(
			row['to_addresses_json'] == null
				? null
				: String(row['to_addresses_json']),
		),
		cc_addresses: parseJsonStringArray(
			row['cc_addresses_json'] == null
				? null
				: String(row['cc_addresses_json']),
		),
		reply_to_addresses: parseJsonStringArray(
			row['reply_to_addresses_json'] == null
				? null
				: String(row['reply_to_addresses_json']),
		),
		headers: parseHeaders(
			row['headers_json'] == null ? null : String(row['headers_json']),
		),
		text_body: row['text_body'] == null ? null : String(row['text_body']),
		html_body: row['html_body'] == null ? null : String(row['html_body']),
		raw_mime: await loadRawMime({
			blobs,
			message: {
				rawMimeKey:
					row['raw_mime_key'] == null ? null : String(row['raw_mime_key']),
			},
		}),
		attachments: await listAttachments(db, messageId),
	}
}

export async function loadAdminSystemEmailData(
	env: Env,
	requestUrl: string,
): Promise<AdminSystemEmailLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const { page, pageSize } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const selectedMessageId = url.searchParams.get('messageId')?.trim() || null
	return readAdminSystemEmailData(env, {
		page,
		pageSize,
		messageId: selectedMessageId,
	})
}
export async function readAdminSystemEmailData(
	env: Env,
	input: { page: number; pageSize: number; messageId: string | null },
): Promise<AdminSystemEmailLoaderData> {
	const page = Math.max(1, Math.floor(input.page))
	const pageSize = Math.min(
		maxPageSize,
		Math.max(1, Math.floor(input.pageSize)),
	)
	const offset = (page - 1) * pageSize
	const selectedMessageId = input.messageId?.trim() || null
	const [list, selectedMessage] = await Promise.all([
		listSystemEmailAdminMessages({
			db: env.APP_DB,
			pageSize,
			offset,
		}),
		selectedMessageId
			? loadAdminSystemEmailMessageById(
					env.APP_DB,
					selectedMessageId,
					env.EMAIL_BLOBS,
				)
			: Promise.resolve(null),
	])
	return {
		ok: true,
		ownerId: systemEmailOwnerId,
		systemLocals: [...systemEmailLocals],
		limits: { ...systemEmailLimits },
		messages: list.rows.map(toListItem),
		selectedMessage,
		page,
		pageSize,
		total: list.total,
	}
}
