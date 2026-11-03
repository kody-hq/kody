import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Derived D1 reverse index: outbound provider message id → owning message.
 * Mailbox is authoritative; this table exists only so contextless provider
 * webhooks can resolve one owner/message without enumerating Mailbox objects.
 */

export const emailOutboundProviderCloudflare = 'cloudflare-email'

export type EmailOutboundProviderIndexRow = {
	provider: string
	providerMessageId: string
	userId: OwnerId
	messageId: string
	inboxId: string | null
	createdAt: string
	updatedAt: string
}

export type OutboundProviderIndexHealthReport = {
	indexCount: number
	distinctOwnerCount: number
	malformedCount: number
	healthy: boolean
}

export function classifyOutboundProviderIndexHealth(
	counts: Pick<
		OutboundProviderIndexHealthReport,
		'indexCount' | 'distinctOwnerCount' | 'malformedCount'
	>,
): OutboundProviderIndexHealthReport {
	return {
		...counts,
		healthy: counts.malformedCount === 0,
	}
}

function mapIndexRow(
	row: Record<string, unknown>,
): EmailOutboundProviderIndexRow {
	return {
		provider: String(row['provider']),
		providerMessageId: String(row['provider_message_id']),
		userId: String(row['user_id']) as OwnerId,
		messageId: String(row['message_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export async function getOutboundProviderIndexRow(input: {
	db: D1Database
	provider?: string
	providerMessageId: string
}): Promise<EmailOutboundProviderIndexRow | null> {
	const provider = input.provider ?? emailOutboundProviderCloudflare
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_outbound_provider_index
			WHERE provider = ?
				AND provider_message_id = ?
			LIMIT 1`,
		)
		.bind(provider, input.providerMessageId)
		.first<Record<string, unknown>>()
	return row ? mapIndexRow(row) : null
}

export async function upsertOutboundProviderIndexRow(input: {
	db: D1Database
	provider?: string
	providerMessageId: string
	userId: OwnerId
	messageId: string
	inboxId: string | null
	now: string
}): Promise<void> {
	const provider = input.provider ?? emailOutboundProviderCloudflare
	await input.db
		.prepare(
			`INSERT INTO email_outbound_provider_index (
				provider, provider_message_id, user_id, message_id, inbox_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(provider, provider_message_id) DO UPDATE SET
				user_id = excluded.user_id,
				message_id = excluded.message_id,
				inbox_id = excluded.inbox_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			provider,
			input.providerMessageId,
			input.userId,
			input.messageId,
			input.inboxId,
			input.now,
			input.now,
		)
		.run()
}

export async function deleteOutboundProviderIndexByMessageId(input: {
	db: D1Database
	messageId: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM email_outbound_provider_index
			WHERE message_id = ?`,
		)
		.bind(input.messageId)
		.run()
	return Number(result.meta.changes ?? 0)
}

export async function deleteOutboundProviderIndexByMessageIds(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
}): Promise<number> {
	if (input.messageIds.length === 0) return 0
	let deleted = 0
	const chunkSize = 100
	for (let index = 0; index < input.messageIds.length; index += chunkSize) {
		const chunk = input.messageIds.slice(index, index + chunkSize)
		const results = await input.db.batch(
			chunk.map((messageId) =>
				input.db
					.prepare(
						`DELETE FROM email_outbound_provider_index
						WHERE message_id = ?`,
					)
					.bind(messageId),
			),
		)
		deleted += results.reduce(
			(total, result) => total + Number(result.meta.changes ?? 0),
			0,
		)
	}
	return deleted
}

/**
 * Read-only structural report over the thin reverse index.
 */
export async function loadOutboundProviderIndexHealthReport(input: {
	db: D1Database
	userId?: string
}): Promise<OutboundProviderIndexHealthReport> {
	const userId = input.userId ?? null
	const row = await input.db
		.prepare(
			`SELECT
				COUNT(*) AS index_count,
				COUNT(DISTINCT user_id) AS distinct_owner_count,
				COALESCE(SUM(
					CASE
						WHEN provider = ''
							OR provider_message_id = ''
							OR user_id = ''
							OR message_id = ''
						THEN 1
						ELSE 0
					END
				), 0) AS malformed_count
			FROM email_outbound_provider_index
			WHERE ?1 IS NULL OR user_id = ?1`,
		)
		.bind(userId)
		.first<{
			index_count: number
			distinct_owner_count: number
			malformed_count: number
		}>()

	const indexCount = Number(row?.index_count ?? 0)
	const distinctOwnerCount = Number(row?.distinct_owner_count ?? 0)
	const malformedCount = Number(row?.malformed_count ?? 0)
	return classifyOutboundProviderIndexHealth({
		indexCount,
		distinctOwnerCount,
		malformedCount,
	})
}
