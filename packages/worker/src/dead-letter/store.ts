import { type DeadLetterPayloadMetadata } from './metadata.ts'

export type DeadLetterMessageStatus = 'parked' | 'replaying'

export type ParkedDeadLetterMessage = {
	deadLetterQueue: string
	messageId: string
	sourceQueue: string
	status: DeadLetterMessageStatus
	bodyJson: string | null
	metadata: DeadLetterPayloadMetadata
	attempts: number
	enqueuedAtMs: number
	parkedAtMs: number
	claimedAtMs: number | null
}

type DeadLetterMessageRow = {
	dead_letter_queue: string
	message_id: string
	source_queue: string
	status: DeadLetterMessageStatus
	body_json: string | null
	payload_type: DeadLetterPayloadMetadata['payloadType']
	payload_bytes: number
	top_level_keys_json: string
	top_level_key_count: number
	message_kind: string | null
	stable_ids_json: string
	attempts: number
	enqueued_at_ms: number
	parked_at_ms: number
	claimed_at_ms: number | null
}

const columns = `dead_letter_queue, message_id, source_queue, status, body_json,
	payload_type, payload_bytes, top_level_keys_json, top_level_key_count,
	message_kind, stable_ids_json, attempts, enqueued_at_ms, parked_at_ms,
	claimed_at_ms`

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

function fromRow(row: DeadLetterMessageRow): ParkedDeadLetterMessage {
	return {
		deadLetterQueue: row.dead_letter_queue,
		messageId: row.message_id,
		sourceQueue: row.source_queue,
		status: row.status,
		bodyJson: row.body_json,
		metadata: {
			payloadType: row.payload_type,
			payloadBytes: Number(row.payload_bytes),
			topLevelKeys: parseJson<Array<string>>(row.top_level_keys_json, []),
			topLevelKeyCount: Number(row.top_level_key_count),
			kind: row.message_kind,
			stableIds: parseJson<Record<string, string>>(row.stable_ids_json, {}),
		},
		attempts: Number(row.attempts),
		enqueuedAtMs: Number(row.enqueued_at_ms),
		parkedAtMs: Number(row.parked_at_ms),
		claimedAtMs: row.claimed_at_ms === null ? null : Number(row.claimed_at_ms),
	}
}

/**
 * Parks a message. Queue delivery is at-least-once, so a redelivered message
 * keeps its first parked row.
 */
export async function parkDeadLetterMessage(
	db: D1Database,
	message: Omit<ParkedDeadLetterMessage, 'status' | 'claimedAtMs'>,
) {
	await db
		.prepare(
			`INSERT OR IGNORE INTO dead_letter_messages (${columns})
			 VALUES (?, ?, ?, 'parked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			message.deadLetterQueue,
			message.messageId,
			message.sourceQueue,
			message.bodyJson,
			message.metadata.payloadType,
			message.metadata.payloadBytes,
			JSON.stringify(message.metadata.topLevelKeys),
			message.metadata.topLevelKeyCount,
			message.metadata.kind,
			JSON.stringify(message.metadata.stableIds),
			message.attempts,
			message.enqueuedAtMs,
			message.parkedAtMs,
		)
		.run()
}

export type ParkedDeadLetterSummary = {
	deadLetterQueue: string
	count: number
	oldestEnqueuedAtMs: number | null
}

export async function summarizeParkedDeadLetterMessages(
	db: D1Database,
): Promise<Map<string, ParkedDeadLetterSummary>> {
	const result = await db
		.prepare(
			`SELECT dead_letter_queue, COUNT(*) AS count,
				MIN(enqueued_at_ms) AS oldest_enqueued_at_ms
			 FROM dead_letter_messages
			 GROUP BY dead_letter_queue`,
		)
		.all<{
			dead_letter_queue: string
			count: number
			oldest_enqueued_at_ms: number | null
		}>()
	const summaries = new Map<string, ParkedDeadLetterSummary>()
	for (const row of result.results ?? []) {
		summaries.set(row.dead_letter_queue, {
			deadLetterQueue: row.dead_letter_queue,
			count: Number(row.count),
			oldestEnqueuedAtMs:
				row.oldest_enqueued_at_ms === null
					? null
					: Number(row.oldest_enqueued_at_ms),
		})
	}
	return summaries
}

export type DeadLetterPageCursor = { enqueuedAtMs: number; messageId: string }

export async function listParkedDeadLetterMessages(
	db: D1Database,
	input: {
		deadLetterQueue: string
		limit: number
		after?: DeadLetterPageCursor | null
	},
): Promise<{
	messages: Array<ParkedDeadLetterMessage>
	next: DeadLetterPageCursor | null
}> {
	const after = input.after ?? null
	const statement = after
		? db
				.prepare(
					`SELECT ${columns} FROM dead_letter_messages
					 WHERE dead_letter_queue = ?
						AND (enqueued_at_ms > ? OR (enqueued_at_ms = ? AND message_id > ?))
					 ORDER BY enqueued_at_ms, message_id
					 LIMIT ?`,
				)
				.bind(
					input.deadLetterQueue,
					after.enqueuedAtMs,
					after.enqueuedAtMs,
					after.messageId,
					input.limit + 1,
				)
		: db
				.prepare(
					`SELECT ${columns} FROM dead_letter_messages
					 WHERE dead_letter_queue = ?
					 ORDER BY enqueued_at_ms, message_id
					 LIMIT ?`,
				)
				.bind(input.deadLetterQueue, input.limit + 1)
	const result = await statement.all<DeadLetterMessageRow>()
	const rows = (result.results ?? []).map(fromRow)
	const messages = rows.slice(0, input.limit)
	const last = messages.at(-1)
	return {
		messages,
		next:
			rows.length > input.limit && last
				? { enqueuedAtMs: last.enqueuedAtMs, messageId: last.messageId }
				: null,
	}
}

export async function getParkedDeadLetterMessage(
	db: D1Database,
	input: { deadLetterQueue: string; messageId: string },
): Promise<ParkedDeadLetterMessage | null> {
	const row = await db
		.prepare(
			`SELECT ${columns} FROM dead_letter_messages
			 WHERE dead_letter_queue = ? AND message_id = ?`,
		)
		.bind(input.deadLetterQueue, input.messageId)
		.first<DeadLetterMessageRow>()
	return row ? fromRow(row) : null
}

/**
 * Claims a parked message for replay so two concurrent replays cannot both
 * resend it. A claim older than `staleClaimMs` (a replay that crashed between
 * send and delete) can be taken over.
 */
export async function claimDeadLetterMessageForReplay(
	db: D1Database,
	input: {
		deadLetterQueue: string
		messageId: string
		nowMs: number
		staleClaimMs: number
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE dead_letter_messages
			 SET status = 'replaying', claimed_at_ms = ?
			 WHERE dead_letter_queue = ? AND message_id = ?
				AND (status = 'parked' OR claimed_at_ms < ?)`,
		)
		.bind(
			input.nowMs,
			input.deadLetterQueue,
			input.messageId,
			input.nowMs - input.staleClaimMs,
		)
		.run()
	return Number(result.meta?.changes ?? 0) > 0
}

export async function releaseDeadLetterReplayClaim(
	db: D1Database,
	input: { deadLetterQueue: string; messageId: string },
) {
	await db
		.prepare(
			`UPDATE dead_letter_messages
			 SET status = 'parked', claimed_at_ms = NULL
			 WHERE dead_letter_queue = ? AND message_id = ?`,
		)
		.bind(input.deadLetterQueue, input.messageId)
		.run()
}

export async function deleteParkedDeadLetterMessage(
	db: D1Database,
	input: { deadLetterQueue: string; messageId: string },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM dead_letter_messages
			 WHERE dead_letter_queue = ? AND message_id = ?`,
		)
		.bind(input.deadLetterQueue, input.messageId)
		.run()
	return Number(result.meta?.changes ?? 0) > 0
}

/**
 * Deletes up to `limit` parked messages (oldest first) so one purge call keeps
 * its delete and audit fan-out bounded. Call again while `remainingCount > 0`.
 */
export async function purgeParkedDeadLetterMessages(
	db: D1Database,
	input: { deadLetterQueue: string; limit: number },
): Promise<{ messageIds: Array<string>; remainingCount: number }> {
	// One batch is one transaction: a failed count rolls back the delete, so a
	// purge never deletes rows it cannot report (and audit).
	const [result, remaining] = await db.batch<{
		message_id?: string
		count?: number
	}>([
		db
			.prepare(
				`DELETE FROM dead_letter_messages
				 WHERE rowid IN (
					SELECT rowid FROM dead_letter_messages
					WHERE dead_letter_queue = ?
					ORDER BY enqueued_at_ms ASC, message_id ASC
					LIMIT ?
				 )
				 RETURNING message_id`,
			)
			.bind(input.deadLetterQueue, input.limit),
		db
			.prepare(
				`SELECT COUNT(*) AS count FROM dead_letter_messages WHERE dead_letter_queue = ?`,
			)
			.bind(input.deadLetterQueue),
	])
	return {
		messageIds: (result?.results ?? [])
			.map((row) => String(row.message_id))
			.sort(),
		remainingCount: Number(remaining?.results?.[0]?.count ?? 0),
	}
}
