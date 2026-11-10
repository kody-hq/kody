import { nextState } from '@kody-internal/shared/state-machine.ts'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'

export const systemInboundProvider = 'cloudflare-email-routing'
export const systemInboundDedupeProvider = 'cloudflare-email-routing-dedupe'
export const systemInboundDeletedRejectionReason = 'Message deleted.'

export function systemInboundDedupePointerId(fingerprint: string) {
	return `email-inbound-dedupe:${fingerprint}`
}

/**
 * Pointer ids currently owned by these messages (`detail_json.messageId`).
 * Do not derive ids from historical charged fingerprints: after the 48h window
 * expires, the same fingerprint pointer can be claimed by a newer delivery.
 */
export async function listSystemInboundDedupePointerIdsForMessages(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
}): Promise<Array<string>> {
	const owned = await listSystemInboundDedupePointersOwnedByMessages(input)
	return [...new Set(owned.map((row) => row.pointerId))]
}

async function listSystemInboundDedupePointersOwnedByMessages(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
}): Promise<Array<{ pointerId: string; messageId: string }>> {
	if (input.messageIds.length === 0) return []
	const statements = input.messageIds.map((messageId) =>
		input.db
			.prepare(
				`SELECT id
				FROM system_email_delivery_events
				WHERE provider = ?
					AND json_extract(detail_json, '$.messageId') = ?`,
			)
			.bind(systemInboundDedupeProvider, messageId),
	)
	const batches = await input.db.batch(statements)
	const owned: Array<{ pointerId: string; messageId: string }> = []
	for (let index = 0; index < input.messageIds.length; index += 1) {
		const messageId = input.messageIds[index]
		if (!messageId) continue
		for (const row of (batches[index]?.results ?? []) as Array<{
			id: string
		}>) {
			owned.push({ pointerId: row.id, messageId })
		}
	}
	return owned
}

export function tombstoneSystemInboundDedupePointerStatement(input: {
	db: D1Database
	pointerId: string
	messageId: string
	now: string
}) {
	nextState(inboundDedupePointerState, 'pending', { type: 'TOMBSTONE' })
	nextState(inboundDedupePointerState, 'rejected', { type: 'TOMBSTONE' })
	return input.db
		.prepare(
			`UPDATE system_email_delivery_events
			SET event_type = 'rejected',
				state = 'rejected',
				detail_json = json_set(
					detail_json, '$.state', 'rejected', '$.rejectionReason', ?
				),
				updated_at = ?
			WHERE id = ? AND provider = ?
				AND json_extract(detail_json, '$.messageId') = ?`,
		)
		.bind(
			systemInboundDeletedRejectionReason,
			input.now,
			input.pointerId,
			systemInboundDedupeProvider,
			input.messageId,
		)
}

export async function systemInboundDedupeTombstoneStatements(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
	now?: Date
}): Promise<Array<D1PreparedStatement>> {
	const owned = await listSystemInboundDedupePointersOwnedByMessages(input)
	if (owned.length === 0) return []
	const now = (input.now ?? new Date()).toISOString()
	return owned.map(({ pointerId, messageId }) =>
		tombstoneSystemInboundDedupePointerStatement({
			db: input.db,
			pointerId,
			messageId,
			now,
		}),
	)
}
