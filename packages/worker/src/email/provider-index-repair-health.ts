import { systemEmailOwnerId } from './email-owner.ts'
import type { MailboxProviderIndexRepairStatus } from './mailbox-provider-index-repair.ts'

export async function syncProviderIndexRepairOwnerHealth(input: {
	db: D1Database
	userId: string
	status: MailboxProviderIndexRepairStatus
	now?: Date
}) {
	if (input.userId === systemEmailOwnerId) return
	if (input.status.pendingCount === 0 || input.status.oldestPendingAt == null) {
		await input.db
			.prepare(
				`DELETE FROM email_outbound_provider_index_repair_owners
				WHERE user_id = ?`,
			)
			.bind(input.userId)
			.run()
		return
	}
	await input.db
		.prepare(
			`INSERT INTO email_outbound_provider_index_repair_owners (
				user_id, pending_count, oldest_pending_at, updated_at
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				pending_count = excluded.pending_count,
				oldest_pending_at = excluded.oldest_pending_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.status.pendingCount,
			input.status.oldestPendingAt,
			(input.now ?? new Date()).toISOString(),
		)
		.run()
}

export async function loadProviderIndexRepairHealth(input: {
	db: D1Database
}): Promise<{
	pendingOwners: number
	pendingCount: number
	oldestPendingAt: string | null
}> {
	const row = await input.db
		.prepare(
			`SELECT
				COUNT(*) AS pending_owners,
				COALESCE(SUM(pending_count), 0) AS pending_count,
				MIN(oldest_pending_at) AS oldest_pending_at
			FROM email_outbound_provider_index_repair_owners`,
		)
		.first<{
			pending_owners: number
			pending_count: number
			oldest_pending_at: string | null
		}>()
	return {
		pendingOwners: Number(row?.pending_owners ?? 0),
		pendingCount: Number(row?.pending_count ?? 0),
		oldestPendingAt: row?.oldest_pending_at ?? null,
	}
}
