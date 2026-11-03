import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { systemEmailOwnerId } from './email-owner.ts'

export const inboundDueOwnerBatchSize = 25
export const inboundDueOwnerFailureDelayMs = 5 * 60 * 1000
export const mailboxInboundStaleDeliveryAgeMs = 48 * 60 * 60 * 1000

export type InboundDueOwner = {
	userId: OwnerId
	dueAt: string
	reason: string
	attemptCount: number
}

export type InboundDueOwnersHealth = {
	pendingOwners: number
	dueOwners: number
	oldestDueAt: string | null
}

export async function hintInboundDueOwner(input: {
	db: D1Database
	userId: string
	dueAt: string
	reason: string
	now?: Date
}) {
	if (input.userId === systemEmailOwnerId) return
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`INSERT INTO email_inbound_due_owners (
				user_id, due_at, reason, attempt_count, last_error, updated_at
			) VALUES (?, ?, ?, 0, NULL, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				due_at = MIN(email_inbound_due_owners.due_at, excluded.due_at),
				reason = CASE
					WHEN excluded.due_at <= email_inbound_due_owners.due_at
					THEN excluded.reason
					ELSE email_inbound_due_owners.reason
				END,
				updated_at = excluded.updated_at`,
		)
		.bind(input.userId, input.dueAt, input.reason, now.toISOString())
		.run()
}

export async function replaceInboundDueOwnerHint(input: {
	db: D1Database
	userId: string
	dueAt: string | null
	reason: string
	now?: Date
}) {
	if (input.userId === systemEmailOwnerId) return
	if (input.dueAt == null) {
		await input.db
			.prepare(`DELETE FROM email_inbound_due_owners WHERE user_id = ?`)
			.bind(input.userId)
			.run()
		return
	}
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`INSERT INTO email_inbound_due_owners (
				user_id, due_at, reason, attempt_count, last_error, updated_at
			) VALUES (?, ?, ?, 0, NULL, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				due_at = excluded.due_at,
				reason = excluded.reason,
				attempt_count = 0,
				last_error = NULL,
				updated_at = excluded.updated_at`,
		)
		.bind(input.userId, input.dueAt, input.reason, now.toISOString())
		.run()
}

export async function listDueInboundOwners(input: {
	db: D1Database
	now?: Date
	limit?: number
}): Promise<Array<InboundDueOwner>> {
	const rows = await input.db
		.prepare(
			`SELECT user_id, due_at, reason, attempt_count
			FROM email_inbound_due_owners
			WHERE due_at <= ?
			ORDER BY due_at ASC, user_id ASC
			LIMIT ?`,
		)
		.bind(
			(input.now ?? new Date()).toISOString(),
			input.limit ?? inboundDueOwnerBatchSize,
		)
		.all<{
			user_id: OwnerId
			due_at: string
			reason: string
			attempt_count: number
		}>()
	return (rows.results ?? []).map((row) => ({
		userId: row.user_id,
		dueAt: row.due_at,
		reason: row.reason,
		attemptCount: Number(row.attempt_count),
	}))
}

export async function deferInboundDueOwner(input: {
	db: D1Database
	userId: string
	error: unknown
	now?: Date
}) {
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`UPDATE email_inbound_due_owners
			SET due_at = ?, attempt_count = attempt_count + 1,
				last_error = ?, updated_at = ?
			WHERE user_id = ?`,
		)
		.bind(
			new Date(now.getTime() + inboundDueOwnerFailureDelayMs).toISOString(),
			getErrorMessage(input.error).slice(0, 1000),
			now.toISOString(),
			input.userId,
		)
		.run()
}

export async function loadInboundDueOwnersHealth(input: {
	db: D1Database
	now?: Date
}): Promise<InboundDueOwnersHealth> {
	const row = await input.db
		.prepare(
			`SELECT
				COUNT(*) AS pending_owners,
				COALESCE(SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END), 0) AS due_owners,
				MIN(due_at) AS oldest_due_at
			FROM email_inbound_due_owners`,
		)
		.bind((input.now ?? new Date()).toISOString())
		.first<{
			pending_owners: number
			due_owners: number
			oldest_due_at: string | null
		}>()
	return {
		pendingOwners: Number(row?.pending_owners ?? 0),
		dueOwners: Number(row?.due_owners ?? 0),
		oldestDueAt: row?.oldest_due_at ?? null,
	}
}

export function getMailboxInboundDueAt(
	sql: SqlStorage,
	now?: Date,
): string | null {
	const nowMs = (now ?? new Date()).getTime()
	const candidates: Array<string> = []
	const stale = sql
		.exec<{
			created_at: string
			reconcile_after: string | null
		}>(
			`SELECT created_at, reconcile_after
			FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing'
				AND event_type = 'receive_started'
				AND state IN ('pending', 'storing', 'cleaning', 'orphan-cleaned')
			ORDER BY created_at ASC
			LIMIT 1`,
		)
		.toArray()[0]
	if (stale) {
		candidates.push(
			stale.reconcile_after ??
				new Date(
					Math.max(
						Date.parse(stale.created_at) + mailboxInboundStaleDeliveryAgeMs,
						nowMs,
					),
				).toISOString(),
		)
	}
	const dedupe = sql
		.exec<{ due_at: string }>(
			`SELECT MIN(dedupe_expires_at) AS due_at
			FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing-dedupe'
				AND dedupe_expires_at IS NOT NULL`,
		)
		.toArray()[0]?.due_at
	if (dedupe) candidates.push(dedupe)
	const effects = sql
		.exec<{ due_at: string }>(
			`SELECT MIN(COALESCE(
				usage_effect_retry_at, subscription_effect_retry_at, created_at
			)) AS due_at
			FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing'
				AND event_type = 'received'
				AND needs_effect_reconcile = 1`,
		)
		.toArray()[0]?.due_at
	if (effects) candidates.push(effects)
	return candidates.sort()[0] ?? null
}
