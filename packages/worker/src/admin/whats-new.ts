import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { newsletterSignupState } from '#worker/newsletter/signup-state.ts'
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
		| 'newsletter_page'
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

type RecipientSource = RecipientRow['whats_new_email_opt_in_source']

type Recipient = {
	stable_user_id: string
	email: string
	username: string
	opted_in: boolean
	opt_in_updated_at: string | null
	opt_in_source: RecipientSource
	unsubscribed: boolean
}

/**
 * Recipients are verified live users plus confirmed public sign-ups
 * (`newsletter_signups`) whose address has no verified account. A sign-up that
 * never confirmed is never listed. A verified user who has made no choice on
 * the account but confirmed a public sign-up with the same address counts as
 * opted in; any later account choice wins. Consent given on the public page
 * reports the `newsletter_page` source (the `users` column stores it as
 * `email_link`, matched back to the sign-up by its confirmation time).
 */
export async function listWhatsNewRecipients(input: {
	db: D1Database
	audience: 'opted-in' | 'all-users'
	cursor?: string
	limit: number
}) {
	const cursor = input.cursor ?? ''
	const optedInOnly = input.audience === 'opted-in'
	const [userRows, signupRows] = await input.db.batch<
		RecipientRow & { signup_confirmed_at: string | null }
	>([
		input.db
			.prepare(
				`SELECT u.stable_user_id, u.email, u.username,
				u.whats_new_email_opt_in, u.whats_new_email_opt_in_updated_at, u.whats_new_email_opt_in_source,
				s.confirmed_at AS signup_confirmed_at
			 FROM users u
			 LEFT JOIN newsletter_signups s
				ON s.email = u.email AND s.status = 'confirmed'
				AND s.source = 'newsletter_page'
				AND (u.whats_new_email_opt_in_updated_at IS NULL
					OR u.whats_new_email_opt_in_updated_at = s.confirmed_at)
			 WHERE u.deleted_at IS NULL AND u.deleting_at IS NULL
				AND u.email_verified_at IS NOT NULL
				AND u.stable_user_id > ?
				${optedInOnly ? 'AND (u.whats_new_email_opt_in = 1 OR s.id IS NOT NULL)' : ''}
			 ORDER BY u.stable_user_id LIMIT ?`,
			)
			.bind(cursor, input.limit + 1),
		input.db
			.prepare(
				`SELECT s.stable_id AS stable_user_id, s.email, '' AS username,
				CASE s.status WHEN 'confirmed' THEN 1 ELSE 0 END AS whats_new_email_opt_in,
				s.updated_at AS whats_new_email_opt_in_updated_at,
				s.source AS whats_new_email_opt_in_source,
				NULL AS signup_confirmed_at
			 FROM newsletter_signups s
			 WHERE s.status IN (${optedInOnly ? "'confirmed'" : "'confirmed', 'unsubscribed'"})
				AND s.stable_id > ?
				AND NOT EXISTS (
					SELECT 1 FROM users u
					WHERE u.email = s.email AND u.deleted_at IS NULL
						AND u.deleting_at IS NULL AND u.email_verified_at IS NOT NULL
				)
			 ORDER BY s.stable_id LIMIT ?`,
			)
			.bind(cursor, input.limit + 1),
	])
	const merged = [...userRows!.results, ...signupRows!.results].sort((a, b) =>
		a.stable_user_id < b.stable_user_id ? -1 : 1,
	)
	const page = merged.slice(0, input.limit)
	return {
		users: page.map((row): Recipient => {
			const carried = row.signup_confirmed_at !== null
			return {
				stable_user_id: row.stable_user_id,
				email: row.email,
				username: row.username,
				opted_in: carried || row.whats_new_email_opt_in === 1,
				opt_in_updated_at: carried
					? row.signup_confirmed_at
					: row.whats_new_email_opt_in_updated_at,
				opt_in_source: carried
					? 'newsletter_page'
					: row.whats_new_email_opt_in_source,
				unsubscribed:
					!carried &&
					row.whats_new_email_opt_in === 0 &&
					row.whats_new_email_opt_in_updated_at !== null,
			}
		}),
		next_cursor:
			merged.length > input.limit ? page.at(-1)!.stable_user_id : null,
	}
}

const signupUnsubscribeGuard = sqlSourcesOf(
	newsletterSignupState,
	'UNSUBSCRIBE',
)
const signupResubscribeGuard = sqlSourcesOf(
	newsletterSignupState,
	'RESUBSCRIBE',
)

export async function setWhatsNewOptIn(input: {
	db: D1Database
	stable_user_id: string
	opted_in: boolean
	source: 'email_link' | 'admin'
	occurred_at?: string
}) {
	const updatedAt = input.occurred_at
		? new Date(input.occurred_at).toISOString()
		: new Date().toISOString()
	const flag = input.opted_in ? 1 : 0
	const userRow = await input.db
		.prepare(
			`UPDATE users SET whats_new_email_opt_in = ?, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = ?
		 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
		 RETURNING stable_user_id, email`,
		)
		.bind(flag, updatedAt, input.source, input.stable_user_id)
		.first<{ stable_user_id: string; email: string }>()
	// Account-less recipients: only a sign-up that confirmed at least once
	// can be switched, so this never bypasses double opt-in.
	const signupRow = userRow
		? null
		: await input.db
				.prepare(
					`UPDATE newsletter_signups SET status = ?, source = ?, updated_at = ?
		 WHERE stable_id = ? AND status IN ${input.opted_in ? signupResubscribeGuard : signupUnsubscribeGuard}
		 RETURNING stable_id AS stable_user_id, email`,
				)
				.bind(
					input.opted_in ? 'confirmed' : 'unsubscribed',
					input.source,
					updatedAt,
					input.stable_user_id,
				)
				.first<{ stable_user_id: string; email: string }>()
	// Repeating the current choice (an unsubscribe link opened twice) is not
	// an error, and reports the choice as stored: nothing was written.
	const unchangedRow =
		userRow || signupRow
			? null
			: await input.db
					.prepare(
						`SELECT stable_id AS stable_user_id, email, source, updated_at FROM newsletter_signups
		 WHERE stable_id = ? AND status = ?`,
					)
					.bind(
						input.stable_user_id,
						input.opted_in ? 'confirmed' : 'unsubscribed',
					)
					.first<{
						stable_user_id: string
						email: string
						source: NonNullable<RecipientSource>
						updated_at: string
					}>()
	const row = userRow ?? signupRow ?? unchangedRow
	// An address can hold consent in both places (it signed up, then made an
	// account). Leaving through either id must leave both, or the other record
	// keeps the address on the list.
	if (row && !input.opted_in) {
		if (userRow) {
			await input.db
				.prepare(
					`UPDATE newsletter_signups SET status = 'unsubscribed', source = ?, updated_at = ?
			 WHERE email = ? AND status IN ${signupUnsubscribeGuard}`,
				)
				.bind(input.source, updatedAt, row.email)
				.run()
		} else {
			await input.db
				.prepare(
					`UPDATE users SET whats_new_email_opt_in = 0, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = ?
			 WHERE email = ? AND email_verified_at IS NOT NULL AND deleted_at IS NULL AND deleting_at IS NULL`,
				)
				.bind(updatedAt, input.source, row.email)
				.run()
		}
	}
	if (!row) throw new McpCallerError('User not found.')
	return {
		stable_user_id: row.stable_user_id,
		opted_in: input.opted_in,
		opt_in_updated_at: unchangedRow?.updated_at ?? updatedAt,
		opt_in_source: unchangedRow?.source ?? input.source,
	}
}
