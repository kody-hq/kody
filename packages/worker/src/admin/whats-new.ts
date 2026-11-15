import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import type { EmailDeliveryStatus } from '#worker/email/types.ts'

type RecipientRow = {
	stable_user_id: string
	email: string
	username: string
	whats_new_email_opt_in: number
	whats_new_email_opt_in_updated_at: string | null
	whats_new_email_opt_in_source:
		| 'signup'
		| 'settings'
		| 'email_link'
		| 'admin'
		| null
}

const deliveryCursorSchema = z.tuple([z.iso.datetime(), z.string(), z.string()])

function parseDeliveryCursor(value: string) {
	try {
		return deliveryCursorSchema.parse(JSON.parse(value))
	} catch {
		throw new McpCallerError('Invalid cursor; pass next_cursor unchanged.')
	}
}

export async function listWhatsNewDeliveryEvents(input: {
	db: D1Database
	since?: string
	cursor?: string
	limit: number
}) {
	const cursor = input.cursor ? parseDeliveryCursor(input.cursor) : ['', '', '']
	const rows = await input.db
		.prepare(
			`SELECT provider_message_id, recipient, last_status AS event, last_status_at AS occurred_at
		 FROM system_email_sends
		 WHERE kind = 'whats_new' AND last_status IS NOT NULL AND last_status_at IS NOT NULL
		 AND last_status_at >= ?
		 AND (last_status_at, provider_message_id, recipient) > (?, ?, ?)
		 ORDER BY last_status_at, provider_message_id, recipient LIMIT ?`,
		)
		.bind(
			input.since ? new Date(input.since).toISOString() : '',
			...cursor,
			input.limit + 1,
		)
		.all<{
			provider_message_id: string
			recipient: string
			event: EmailDeliveryStatus
			occurred_at: string
		}>()
	const events = rows.results.slice(0, input.limit)
	const last = events.at(-1)
	return {
		events,
		next_cursor:
			rows.results.length > input.limit && last
				? JSON.stringify([
						last.occurred_at,
						last.provider_message_id,
						last.recipient,
					])
				: null,
	}
}

export async function listWhatsNewRecipients(input: {
	db: D1Database
	audience: 'opted-in' | 'all-users'
	cursor?: string
	limit: number
}) {
	const rows = await input.db
		.prepare(
			`SELECT stable_user_id, email, username,
			whats_new_email_opt_in, whats_new_email_opt_in_updated_at, whats_new_email_opt_in_source
		 FROM users
		 WHERE deleted_at IS NULL AND deleting_at IS NULL
			AND email_verified_at IS NOT NULL
			AND stable_user_id > ?
			${input.audience === 'opted-in' ? 'AND whats_new_email_opt_in = 1' : ''}
		 ORDER BY stable_user_id LIMIT ?`,
		)
		.bind(input.cursor ?? '', input.limit + 1)
		.all<RecipientRow>()
	const page = rows.results.slice(0, input.limit)
	return {
		users: page.map((row) => ({
			stable_user_id: row.stable_user_id,
			email: row.email,
			username: row.username,
			opted_in: row.whats_new_email_opt_in === 1,
			opt_in_updated_at: row.whats_new_email_opt_in_updated_at,
			opt_in_source: row.whats_new_email_opt_in_source,
			unsubscribed:
				row.whats_new_email_opt_in === 0 &&
				row.whats_new_email_opt_in_updated_at !== null,
		})),
		next_cursor:
			rows.results.length > input.limit ? page.at(-1)!.stable_user_id : null,
	}
}

export async function setWhatsNewOptIn(input: {
	db: D1Database
	stable_user_id: string
	opted_in: boolean
	source: 'email_link' | 'admin'
}) {
	const updatedAt = new Date().toISOString()
	const row = await input.db
		.prepare(
			`UPDATE users SET whats_new_email_opt_in = ?, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = ?
		 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
		 RETURNING stable_user_id`,
		)
		.bind(input.opted_in ? 1 : 0, updatedAt, input.source, input.stable_user_id)
		.first<{ stable_user_id: string }>()
	if (!row) throw new McpCallerError('User not found.')
	return {
		stable_user_id: row.stable_user_id,
		opted_in: input.opted_in,
		opt_in_updated_at: updatedAt,
		opt_in_source: input.source,
	}
}
