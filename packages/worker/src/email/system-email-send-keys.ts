/**
 * Idempotency keys for newsletter sends (`system_email_send_keys`). A key is
 * reserved before the daily counter or Cloudflare is touched, so a caller that
 * loses the response can retry with the same key without sending twice.
 */

import { McpCallerError } from '#mcp/caller-error.ts'
import { systemEmailSendRetentionDays } from './system-email-sends.ts'

export const sendKeyOutcomeUnknownMessage =
	'Outcome unknown for this idempotency_key: an earlier attempt did not finish, so it was not retried. It may or may not have been delivered.'

export type SendKeyClaim =
	| { type: 'claimed' }
	| { type: 'replay'; sender: string; providerMessageId: string | null }

type SendKeyRow = {
	recipient: string
	state: 'pending' | 'sent' | 'failed' | 'unknown'
	sender: string | null
	provider_message_id: string | null
}

/**
 * Reserve `key` for one send to `recipient`. Returns `claimed` when the
 * caller may send now (a new key, or one whose earlier attempt failed before
 * reaching Cloudflare), or `replay` with the stored result of a finished send.
 * Throws when the key belongs to another recipient or an earlier attempt's
 * outcome is unknown.
 */
export async function claimSystemEmailSendKey(input: {
	db: D1Database
	kind: string
	key: string
	recipient: string
	now: Date
}): Promise<SendKeyClaim> {
	const at = input.now.toISOString()
	const inserted = await input.db
		.prepare(
			`INSERT INTO system_email_send_keys
				(kind, idempotency_key, recipient, state, created_at, updated_at)
			VALUES (?1, ?2, ?3, 'pending', ?4, ?4)
			ON CONFLICT (kind, idempotency_key) DO NOTHING`,
		)
		.bind(input.kind, input.key, input.recipient, at)
		.run()
	if (Number(inserted.meta.changes ?? 0) === 1) return { type: 'claimed' }
	const row = await input.db
		.prepare(
			`SELECT recipient, state, sender, provider_message_id
			FROM system_email_send_keys WHERE kind = ?1 AND idempotency_key = ?2`,
		)
		.bind(input.kind, input.key)
		.first<SendKeyRow>()
	if (!row) throw new Error('Idempotency key row vanished during claim.')
	if (row.recipient !== input.recipient) {
		throw new McpCallerError(
			'This idempotency_key was already used for a different recipient.',
		)
	}
	if (row.state === 'sent') {
		return {
			type: 'replay',
			sender: row.sender ?? '',
			providerMessageId: row.provider_message_id,
		}
	}
	if (row.state === 'failed') {
		const retried = await input.db
			.prepare(
				`UPDATE system_email_send_keys SET state = 'pending', updated_at = ?3
				WHERE kind = ?1 AND idempotency_key = ?2 AND state = 'failed'`,
			)
			.bind(input.kind, input.key, at)
			.run()
		if (Number(retried.meta.changes ?? 0) === 1) return { type: 'claimed' }
	}
	throw new McpCallerError(sendKeyOutcomeUnknownMessage)
}

/** Record how a claimed attempt ended. */
export async function finishSystemEmailSendKey(input: {
	db: D1Database
	kind: string
	key: string
	state: 'sent' | 'failed' | 'unknown'
	sender?: string
	providerMessageId?: string | null
	now: Date
}) {
	await input.db
		.prepare(
			`UPDATE system_email_send_keys
			SET state = ?3, sender = ?4, provider_message_id = ?5, updated_at = ?6
			WHERE kind = ?1 AND idempotency_key = ?2 AND state = 'pending'`,
		)
		.bind(
			input.kind,
			input.key,
			input.state,
			input.sender ?? null,
			input.providerMessageId ?? null,
			input.now.toISOString(),
		)
		.run()
}

export async function pruneSystemEmailSendKeys(input: {
	db: D1Database
	now: Date
	limit?: number
}): Promise<number> {
	const cutoff = new Date(
		input.now.getTime() - systemEmailSendRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
	const result = await input.db
		.prepare(
			`DELETE FROM system_email_send_keys
			WHERE rowid IN (
				SELECT rowid FROM system_email_send_keys
				WHERE created_at < ?
				ORDER BY created_at ASC
				LIMIT ?
			)`,
		)
		.bind(cutoff, input.limit ?? 1000)
		.run()
	return Number(result.meta.changes ?? 0)
}
