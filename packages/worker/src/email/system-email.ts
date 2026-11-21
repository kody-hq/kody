import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { maxRawMimeBytes } from './parser.ts'
import {
	pruneRecipientSuppressionTracking,
	pruneRecipientSuppressionTrackingEffect,
} from './recipient-suppression.ts'
import {
	pruneSystemEmailSends,
	pruneSystemEmailSendsEffect,
} from './system-email-sends.ts'
import { buildPlatformEmailAddress } from './platform-address.ts'
import {
	createEmailInbox,
	createEmailInboxAddress,
	deleteEmailInboxAddressById,
	emailRawMimeKey,
	getEmailInboxAddressByAddress,
	getEmailInboxById,
	getEmailInboxByName,
} from './repo.ts'
import type { EmailInboxAddressRecord, EmailInboxRecord } from './types.ts'
import {
	assertSystemEmailGraphAuthority,
	assertSystemEmailGraphAuthorityEffect,
	commitSystemEmailAuthorityBatch,
	commitSystemEmailAuthorityBatchEffect,
} from './system-email-authority.ts'
import { Clock, Effect, Schema } from 'effect'
import { type D1, fromD1Promise, makeD1, sql } from '#worker/effect/d1.ts'
import { outbound } from '#worker/effect/outbound.ts'
import { observabilityLayer } from '#worker/effect/observability.ts'
import {
	systemInboundDedupeTombstoneStatements,
	systemInboundProvider,
} from './system-inbound-dedupe.ts'

export { systemEmailOwnerId }

export const transactionalSystemEmailLocals = [
	'kody',
	'support',
	'abuse',
	'dmca',
	'postmaster',
	'security',
	'admin',
	// Public Suffix List contact for the kody.run listing (#1405).
	'psl',
	// Founder replies (the founder welcome Reply-To). A zone Email Routing rule
	// forwards kent@ straight to Kent; accepting it here keeps a catch-all
	// fallback that lands in the system inbox if that rule is ever removed.
	'kent',
] as const

export const systemEmailLocals = [
	...transactionalSystemEmailLocals,
	'news',
] as const

export type SystemEmailLocal = (typeof systemEmailLocals)[number]

/**
 * Inbound-only apex aliases. Mail to the alias local is stored in the
 * canonical system inbox; the envelope/`To` address stays as received.
 * Aliases are never valid `sendSystemEmail` senders (keep
 * `systemEmailLocals` as the outbound allowlist).
 *
 * Keep `permanentlyReservedSystemInboundAliasLocals` in sync for every key
 * here (exact/compact permanent reserve — not substring roots).
 */
export const systemEmailInboundAliases = {
	team: 'support',
} as const satisfies Record<string, SystemEmailLocal>

export type SystemEmailInboundAliasLocal =
	keyof typeof systemEmailInboundAliases

export const systemEmailLimits = {
	maxMessageBytes: maxRawMimeBytes,
	maxReceivesPerDay: 1000,
	/** Per-sender ceiling on operator sends (see `sendSystemEmail`). */
	maxSendsPerDay: 200,
	maxNewsletterSendsPerDay: 2000,
	maxStoredMessages: 5000,
	retentionDays: 90,
	pruneBatchSize: 500,
} as const

/**
 * Wall-clock budget for one system-email retention run. Deletes keep looping
 * in pruneBatchSize batches until the backlog is drained or the budget is
 * exhausted, so a large backlog never turns into one unbounded DELETE.
 */
export const systemEmailPruneTimeBudgetMs = 10_000

/**
 * D1 caps bound parameters per statement at 100. Keep room for owner/cutoff
 * fences used by dedicated authority statements.
 */
const systemEmailDeleteIdsMaxParameters = 40

const systemEmailLocalSet = new Set<string>(systemEmailLocals)

const systemEmailInboundAliasMap = new Map<string, SystemEmailLocal>(
	Object.entries(systemEmailInboundAliases) as Array<
		[SystemEmailInboundAliasLocal, SystemEmailLocal]
	>,
)

export type ProvisionedSystemEmailInbox = {
	inbox: EmailInboxRecord
	address: EmailInboxAddressRecord
}

export function isSystemEmailLocal(
	localPart: string,
): localPart is SystemEmailLocal {
	return systemEmailLocalSet.has(localPart.trim().toLowerCase())
}

/**
 * Resolve an apex inbound local to its canonical system inbox local.
 * Own locals map to themselves; inbound aliases map to their target.
 */
export function resolveSystemEmailInboundLocal(
	localPart: string,
): SystemEmailLocal | null {
	const normalized = localPart.trim().toLowerCase()
	if (isSystemEmailLocal(normalized)) return normalized
	return systemEmailInboundAliasMap.get(normalized) ?? null
}

export async function ensureSystemEmailInbox(input: {
	db: D1Database
	localPart: SystemEmailLocal
	domain: string
}): Promise<ProvisionedSystemEmailInbox | null> {
	const localPart = input.localPart.trim().toLowerCase() as SystemEmailLocal
	const address = buildPlatformEmailAddress({
		username: localPart,
		domain: input.domain,
	})

	const readExisting = async () => {
		const existingAddress = await getEmailInboxAddressByAddress({
			db: input.db,
			address,
		})
		if (!existingAddress) return null
		if (existingAddress.userId !== systemEmailOwnerId) {
			await deleteEmailInboxAddressById({
				db: input.db,
				addressId: existingAddress.id,
			})
			return null
		}
		if (!existingAddress.enabled) {
			return { conflict: true as const }
		}
		const inbox = await getEmailInboxById({
			db: input.db,
			userId: systemEmailOwnerId,
			id: existingAddress.inboxId,
		})
		if (!inbox?.enabled) return { conflict: true as const }
		return { conflict: false as const, inbox, address: existingAddress }
	}

	const existing = await readExisting()
	if (existing) {
		return existing.conflict
			? null
			: { inbox: existing.inbox, address: existing.address }
	}

	let inbox = await getEmailInboxByName({
		db: input.db,
		userId: systemEmailOwnerId,
		name: localPart,
	})
	if (!inbox) {
		try {
			inbox = await createEmailInbox({
				db: input.db,
				userId: systemEmailOwnerId,
				name: localPart,
				description: `Operator-owned system inbox for ${address}`,
			})
		} catch (error) {
			inbox = await getEmailInboxByName({
				db: input.db,
				userId: systemEmailOwnerId,
				name: localPart,
			})
			if (!inbox) throw error
		}
	}

	try {
		const created = await createEmailInboxAddress({
			db: input.db,
			inboxId: inbox.id,
			userId: systemEmailOwnerId,
			address,
			localPart,
			domain: input.domain,
		})
		return { inbox, address: created }
	} catch (error) {
		const raced = await readExisting()
		if (raced) {
			return raced.conflict
				? null
				: { inbox: raced.inbox, address: raced.address }
		}
		throw error
	}
}

export function systemEmailDayKey(now = new Date()) {
	return utcDayKey(now)
}

export async function consumeSystemEmailDailyReceive(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const limit = input.limit ?? systemEmailLimits.maxReceivesPerDay
	const row = await input.db
		.prepare(
			`INSERT INTO system_email_daily_counters (
				local_part, day, count, updated_at
			) VALUES (?, ?, 1, ?)
			ON CONFLICT(local_part, day) DO UPDATE SET
				count = count + 1,
				updated_at = excluded.updated_at
			WHERE count < ?
			RETURNING count`,
		)
		.bind(input.localPart, systemEmailDayKey(now), now.toISOString(), limit)
		.first<{ count: number }>()
	return row ? Number(row.count) : null
}

/**
 * Atomically refund one previously consumed system-inbox daily receive for
 * the given local_part/UTC day (floors at zero). Scoped by `local_part` so a
 * refund cannot touch another system inbox's counter. Pass the same `now`
 * (day key) as the matching `consumeSystemEmailDailyReceive` call.
 */
export async function refundSystemEmailDailyReceive(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`UPDATE system_email_daily_counters
			SET count = MAX(0, count - 1),
				updated_at = ?
			WHERE local_part = ?
				AND day = ?`,
		)
		.bind(now.toISOString(), input.localPart, systemEmailDayKey(now))
		.run()
}

/**
 * Counter key for operator sends. Sends share the daily-counter table with
 * receives but use a prefixed key so the two quotas stay independent (a busy
 * inbox can never block operator correspondence, and vice versa).
 */
function systemEmailSendCounterKey(localPart: SystemEmailLocal) {
	return `send:${localPart}`
}

export async function consumeSystemEmailDailySend(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const limit = input.limit ?? systemEmailLimits.maxSendsPerDay
	const row = await input.db
		.prepare(
			`INSERT INTO system_email_daily_counters (
				local_part, day, count, updated_at
			) VALUES (?, ?, 1, ?)
			ON CONFLICT(local_part, day) DO UPDATE SET
				count = count + 1,
				updated_at = excluded.updated_at
			WHERE count < ?
			RETURNING count`,
		)
		.bind(
			systemEmailSendCounterKey(input.localPart),
			systemEmailDayKey(now),
			now.toISOString(),
			limit,
		)
		.first<{ count: number }>()
	return row ? Number(row.count) : null
}

/**
 * Atomically refund one consumed operator send (floors at zero) so a failed
 * provider call does not permanently spend the day's budget. Pass the same
 * `now` (day key) as the matching consume call.
 */
export async function refundSystemEmailDailySend(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`UPDATE system_email_daily_counters
			SET count = MAX(0, count - 1),
				updated_at = ?
			WHERE local_part = ?
				AND day = ?`,
		)
		.bind(
			now.toISOString(),
			systemEmailSendCounterKey(input.localPart),
			systemEmailDayKey(now),
		)
		.run()
}

export async function countStoredSystemEmailMessages(input: {
	db: D1Database
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM system_email_messages
			WHERE direction = 'inbound'`,
		)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

type SystemEmailMessageCursor = {
	createdAt: string
	id: string
}

async function listSystemEmailMessages(input: {
	db: D1Database
	before?: string
	/**
	 * Keyset cursor (last row examined in the newest-first ordering) so batches
	 * within one prune run advance past rows skipped for blob reasons instead
	 * of reselecting the same blocked head.
	 */
	cursor?: SystemEmailMessageCursor | null
	offset?: number
	limit: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const where = [`direction = 'inbound'`]
	const bindings: Array<string | number> = []
	if (input.before) {
		where.push(`created_at < ?`)
		bindings.push(input.before)
	}
	if (input.cursor) {
		where.push(`(created_at < ? OR (created_at = ? AND id < ?))`)
		bindings.push(
			input.cursor.createdAt,
			input.cursor.createdAt,
			input.cursor.id,
		)
	}
	const offset = input.offset ?? 0
	const result = await input.db
		.prepare(
			`SELECT id, created_at
			FROM system_email_messages
			WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC, id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...bindings, input.limit, offset)
		.all<{ id: string; created_at: string }>()
	return result.results ?? []
}

async function deleteSystemEmailMessagesByIds(input: {
	db: D1Database
	blobs: R2Bucket
	messageIds: ReadonlyArray<string>
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const result = {
		deletedMessages: 0,
		deletedRawMimeBlobs: 0,
		deletedAttachmentBlobs: 0,
		blobDeleteErrors: 0,
	}
	for (
		let index = 0;
		index < input.messageIds.length;
		index += systemEmailDeleteIdsMaxParameters
	) {
		const messageIds = input.messageIds.slice(
			index,
			index + systemEmailDeleteIdsMaxParameters,
		)
		const chunkPlaceholders = messageIds.map(() => '?').join(', ')
		const { results } = await input.db
			.prepare(
				`SELECT id, raw_mime_key
				FROM system_email_messages
				WHERE id IN (${chunkPlaceholders})`,
			)
			.bind(...messageIds)
			.all<{ id: string; raw_mime_key: string | null }>()
		const blobRows = results ?? []
		const attachmentRows = await input.db
			.prepare(
				`SELECT storage_key
				FROM system_email_attachments
				WHERE message_id IN (${chunkPlaceholders})
					AND storage_key IS NOT NULL`,
			)
			.bind(...messageIds)
			.all<{ storage_key: string }>()
		const attachmentBlobKeys = (attachmentRows.results ?? []).map(
			(row) => row.storage_key,
		)
		// Delete R2 blobs before their rows, mirroring the user-mail retention
		// policy: once a row is gone its keys are lost, so a failed blob delete
		// would orphan the object forever. Deletes use the deterministic
		// canonical key. Rows whose blob cannot be deleted are skipped and
		// retried on a later run.
		let deletableIds: ReadonlyArray<string> = messageIds
		if (blobRows.length > 0) {
			const blobRowIds = new Set(blobRows.map((row) => row.id))
			const blobKeys = [
				...blobRows.map((row) => emailRawMimeKey(systemEmailOwnerId, row.id)),
				...attachmentBlobKeys,
			]
			try {
				await input.blobs.delete(blobKeys)
				result.deletedRawMimeBlobs += blobRows.filter(
					(row) => row.raw_mime_key !== null,
				).length
				result.deletedAttachmentBlobs += attachmentBlobKeys.length
			} catch (error) {
				result.blobDeleteErrors += blobRows.length
				deletableIds = messageIds.filter((id) => !blobRowIds.has(id))
				console.warn('system-email-raw-mime-blob-delete-failed', error)
			}
		}
		if (deletableIds.length === 0) continue
		const placeholders = deletableIds.map(() => '?').join(', ')
		const tombstones = await systemInboundDedupeTombstoneStatements({
			db: input.db,
			messageIds: deletableIds,
		})
		const deletes = await commitSystemEmailAuthorityBatch({
			db: input.db,
			statements: [
				...tombstones,
				input.db
					.prepare(
						`DELETE FROM system_email_attachments
						WHERE message_id IN (${placeholders})`,
					)
					.bind(...deletableIds),
				input.db
					.prepare(
						`DELETE FROM system_email_delivery_events
						WHERE message_id IN (${placeholders})
							OR (
								provider = '${systemInboundProvider}'
								AND json_extract(detail_json, '$.messageId')
									IN (${placeholders})
							)`,
					)
					.bind(...deletableIds, ...deletableIds),
				input.db
					.prepare(
						`DELETE FROM system_email_messages
						WHERE id IN (${placeholders})`,
					)
					.bind(...deletableIds),
			],
		})
		result.deletedMessages += Number(
			deletes[tombstones.length + 2]?.meta.changes ?? 0,
		)
	}
	return result
}

export type SystemEmailRetentionResult = {
	deletedMessages: number
	deletedDeliveryEvents: number
	deletedCounters: number
	deletedThreads: number
	/** `system_email_sends` rows past their retention window. */
	deletedSendRecords: number
	/** Unsuppressed below-threshold `email_recipient_suppressions` rows. */
	deletedSuppressionTracking: number
	deletedRawMimeBlobs: number
	deletedAttachmentBlobs: number
	blobDeleteErrors: number
	authority: 'dedicated'
	warnings: Array<'authority-row-delete-skipped'>
}

export async function pruneSystemEmailRetention(input: {
	db: D1Database
	/** EMAIL_BLOBS bucket; raw-MIME blobs are deleted before their rows. */
	blobs: R2Bucket
	now?: Date
	timeBudgetMs?: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const now = input.now ?? new Date()
	const timeBudgetMs = input.timeBudgetMs ?? systemEmailPruneTimeBudgetMs
	const deadlineMs = Date.now() + timeBudgetMs
	const cutoff = new Date(
		now.getTime() - systemEmailLimits.retentionDays * 24 * 60 * 60 * 1000,
	)
	const cutoffIso = cutoff.toISOString()
	const cutoffDay = systemEmailDayKey(cutoff)
	const result: SystemEmailRetentionResult = {
		deletedMessages: 0,
		deletedDeliveryEvents: 0,
		deletedCounters: 0,
		deletedThreads: 0,
		deletedSendRecords: 0,
		deletedSuppressionTracking: 0,
		deletedRawMimeBlobs: 0,
		deletedAttachmentBlobs: 0,
		blobDeleteErrors: 0,
		authority: 'dedicated',
		warnings: [],
	}

	const addMessageDelete = (batch: {
		deletedMessages: number
		deletedRawMimeBlobs: number
		deletedAttachmentBlobs: number
		blobDeleteErrors: number
	}) => {
		result.deletedMessages += batch.deletedMessages
		result.deletedRawMimeBlobs += batch.deletedRawMimeBlobs
		result.deletedAttachmentBlobs += batch.deletedAttachmentBlobs
		result.blobDeleteErrors += batch.blobDeleteErrors
	}

	// Age prune loops batches within the time budget. The keyset cursor marks
	// the last row examined (not the last deleted), so rows skipped because
	// their blob could not be deleted never block later expired rows in the
	// same run; the next run retries the skipped rows from the head.
	let ageCursor: SystemEmailMessageCursor | null = null
	let selectedInBatch = 0
	do {
		const oldMessages = await listSystemEmailMessages({
			db: input.db,
			before: cutoffIso,
			cursor: ageCursor,
			limit: systemEmailLimits.pruneBatchSize,
		})
		selectedInBatch = oldMessages.length
		const lastMessage = oldMessages.at(-1)
		if (!lastMessage) break
		ageCursor = { createdAt: lastMessage.created_at, id: lastMessage.id }
		addMessageDelete(
			await deleteSystemEmailMessagesByIds({
				db: input.db,
				blobs: input.blobs,
				messageIds: oldMessages.map((message) => message.id),
			}),
		)
	} while (
		selectedInBatch >= systemEmailLimits.pruneBatchSize &&
		Date.now() < deadlineMs
	)

	const overCapMessages = await listSystemEmailMessages({
		db: input.db,
		offset: systemEmailLimits.maxStoredMessages,
		limit: systemEmailLimits.pruneBatchSize,
	})
	addMessageDelete(
		await deleteSystemEmailMessagesByIds({
			db: input.db,
			blobs: input.blobs,
			messageIds: overCapMessages.map((message) => message.id),
		}),
	)

	let deletedEventsInBatch = 0
	do {
		const eventRows = await input.db
			.prepare(
				`SELECT id
				FROM system_email_delivery_events
				WHERE created_at < ?
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
			)
			.bind(cutoffIso, systemEmailDeleteIdsMaxParameters)
			.all<{ id: string }>()
		const eventIds = (eventRows.results ?? []).map((row) => row.id)
		deletedEventsInBatch = eventIds.length
		if (eventIds.length > 0) {
			const placeholders = eventIds.map(() => '?').join(', ')
			const deletes = await commitSystemEmailAuthorityBatch({
				db: input.db,
				statements: [
					input.db
						.prepare(
							`DELETE FROM system_email_delivery_events
							WHERE id IN (${placeholders})`,
						)
						.bind(...eventIds),
				],
			})
			deletedEventsInBatch = Number(deletes[0]?.meta.changes ?? 0)
		}
		result.deletedDeliveryEvents += deletedEventsInBatch
	} while (
		deletedEventsInBatch >= systemEmailDeleteIdsMaxParameters &&
		Date.now() < deadlineMs
	)

	const counterDelete = await input.db
		.prepare(`DELETE FROM system_email_daily_counters WHERE day < ?`)
		.bind(cutoffDay)
		.run()
	result.deletedCounters = counterDelete.meta.changes ?? 0
	let deletedInBatch = 0
	do {
		deletedInBatch = await pruneSystemEmailSends({
			db: input.db,
			now,
			limit: systemEmailLimits.pruneBatchSize,
		})
		result.deletedSendRecords += deletedInBatch
	} while (
		deletedInBatch >= systemEmailLimits.pruneBatchSize &&
		Date.now() < deadlineMs
	)
	do {
		deletedInBatch = await pruneRecipientSuppressionTracking({
			db: input.db,
			now,
			limit: systemEmailLimits.pruneBatchSize,
		})
		result.deletedSuppressionTracking += deletedInBatch
	} while (
		deletedInBatch >= systemEmailLimits.pruneBatchSize &&
		Date.now() < deadlineMs
	)

	if (Date.now() < deadlineMs) {
		const threadRows = await input.db
			.prepare(
				`SELECT id FROM system_email_threads
				WHERE NOT EXISTS (
						SELECT 1 FROM system_email_messages
						WHERE system_email_messages.thread_id =
							system_email_threads.id
					)
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
			)
			.bind(systemEmailDeleteIdsMaxParameters)
			.all<{ id: string }>()
		const threadIds = (threadRows.results ?? []).map((row) => row.id)
		if (threadIds.length === 0) return result
		const placeholders = threadIds.map(() => '?').join(', ')
		const deletes = await commitSystemEmailAuthorityBatch({
			db: input.db,
			statements: [
				input.db
					.prepare(
						`DELETE FROM system_email_threads
						WHERE id IN (${placeholders})`,
					)
					.bind(...threadIds),
			],
		})
		result.deletedThreads += Number(deletes[0]?.meta.changes ?? 0)
	}

	return result
}

const MessageIdRow = Schema.Struct({
	id: Schema.String,
	created_at: Schema.String,
})
const BlobRow = Schema.Struct({
	id: Schema.String,
	raw_mime_key: Schema.NullOr(Schema.String),
})
const StorageKeyRow = Schema.Struct({ storage_key: Schema.String })
const IdRow = Schema.Struct({ id: Schema.String })

const listSystemEmailMessagesEffect = Effect.fn(
	'SystemEmailRetention.listMessages',
)(function* (
	d1: D1['Service'],
	input: {
		before?: string
		cursor?: SystemEmailMessageCursor | null
		offset?: number
		limit: number
	},
) {
	yield* assertSystemEmailGraphAuthorityEffect(d1)
	const where = [`direction = 'inbound'`]
	const bindings: Array<string | number> = []
	if (input.before) {
		where.push(`created_at < ?`)
		bindings.push(input.before)
	}
	if (input.cursor) {
		where.push(`(created_at < ? OR (created_at = ? AND id < ?))`)
		bindings.push(
			input.cursor.createdAt,
			input.cursor.createdAt,
			input.cursor.id,
		)
	}
	return yield* d1.all(
		'system_email_messages.list_for_prune',
		MessageIdRow,
		sql(
			`SELECT id, created_at
			FROM system_email_messages
			WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC, id DESC
			LIMIT ? OFFSET ?`,
			...bindings,
			input.limit,
			input.offset ?? 0,
		),
	)
})

const deleteSystemEmailMessagesByIdsEffect = Effect.fn(
	'SystemEmailRetention.deleteMessages',
)(function* (
	d1: D1['Service'],
	input: {
		db: D1Database
		blobs: R2Bucket
		messageIds: ReadonlyArray<string>
	},
) {
	yield* assertSystemEmailGraphAuthorityEffect(d1)
	const result = {
		deletedMessages: 0,
		deletedRawMimeBlobs: 0,
		deletedAttachmentBlobs: 0,
		blobDeleteErrors: 0,
	}
	for (
		let index = 0;
		index < input.messageIds.length;
		index += systemEmailDeleteIdsMaxParameters
	) {
		const messageIds = input.messageIds.slice(
			index,
			index + systemEmailDeleteIdsMaxParameters,
		)
		const chunkPlaceholders = messageIds.map(() => '?').join(', ')
		const blobRows = yield* d1.all(
			'system_email_messages.blob_keys',
			BlobRow,
			sql(
				`SELECT id, raw_mime_key
				FROM system_email_messages
				WHERE id IN (${chunkPlaceholders})`,
				...messageIds,
			),
		)
		const attachmentBlobKeys = (yield* d1.all(
			'system_email_attachments.blob_keys',
			StorageKeyRow,
			sql(
				`SELECT storage_key
				FROM system_email_attachments
				WHERE message_id IN (${chunkPlaceholders})
					AND storage_key IS NOT NULL`,
				...messageIds,
			),
		)).map((row) => row.storage_key)
		// Blobs go before their rows; a row whose blob delete failed stays for
		// the next run so its key is never lost.
		let deletableIds: ReadonlyArray<string> = messageIds
		if (blobRows.length > 0) {
			const blobRowIds = new Set(blobRows.map((row) => row.id))
			const blobKeys = [
				...blobRows.map((row) => emailRawMimeKey(systemEmailOwnerId, row.id)),
				...attachmentBlobKeys,
			]
			yield* outbound('system_email.blobs.delete', () =>
				input.blobs.delete(blobKeys),
			).pipe(
				Effect.matchEffect({
					onSuccess: () =>
						Effect.sync(() => {
							result.deletedRawMimeBlobs += blobRows.filter(
								(row) => row.raw_mime_key !== null,
							).length
							result.deletedAttachmentBlobs += attachmentBlobKeys.length
						}),
					onFailure: (error) =>
						Effect.sync(() => {
							result.blobDeleteErrors += blobRows.length
							deletableIds = messageIds.filter((id) => !blobRowIds.has(id))
							console.warn(
								'system-email-raw-mime-blob-delete-failed',
								error.reason === 'failed' ? error.cause : error,
							)
						}),
				}),
			)
		}
		if (deletableIds.length === 0) continue
		const ids = deletableIds
		const placeholders = ids.map(() => '?').join(', ')
		const tombstones = yield* fromD1Promise(
			'system_email.dedupe_tombstones',
			() =>
				systemInboundDedupeTombstoneStatements({
					db: input.db,
					messageIds: ids,
				}),
		)
		const changes = yield* commitSystemEmailAuthorityBatchEffect({
			db: input.db,
			statements: [
				...tombstones,
				input.db
					.prepare(
						`DELETE FROM system_email_attachments
						WHERE message_id IN (${placeholders})`,
					)
					.bind(...ids),
				input.db
					.prepare(
						`DELETE FROM system_email_delivery_events
						WHERE message_id IN (${placeholders})
							OR (
								provider = '${systemInboundProvider}'
								AND json_extract(detail_json, '$.messageId')
									IN (${placeholders})
							)`,
					)
					.bind(...ids, ...ids),
				input.db
					.prepare(
						`DELETE FROM system_email_messages
						WHERE id IN (${placeholders})`,
					)
					.bind(...ids),
			],
		})
		result.deletedMessages += changes[tombstones.length + 2] ?? 0
	}
	return result
})

/**
 * `pruneSystemEmailRetention` as an Effect: the pass budget is read from
 * `Clock`, every row is schema-checked, and the R2 delete runs under the
 * outbound deadline.
 */
export const pruneSystemEmailRetentionEffect = Effect.fn(
	'SystemEmailRetention.prune',
)(function* (input: {
	db: D1Database
	blobs: R2Bucket
	now?: Date
	timeBudgetMs?: number
}) {
	const d1 = makeD1(() => input.db)
	yield* assertSystemEmailGraphAuthorityEffect(d1)
	const now = input.now ?? new Date(yield* Clock.currentTimeMillis)
	const deadlineMs =
		(yield* Clock.currentTimeMillis) +
		(input.timeBudgetMs ?? systemEmailPruneTimeBudgetMs)
	const withinBudget = Effect.map(
		Clock.currentTimeMillis,
		(millis) => millis < deadlineMs,
	)
	const cutoff = new Date(
		now.getTime() - systemEmailLimits.retentionDays * 24 * 60 * 60 * 1000,
	)
	const cutoffIso = cutoff.toISOString()
	const cutoffDay = systemEmailDayKey(cutoff)
	const result: SystemEmailRetentionResult = {
		deletedMessages: 0,
		deletedDeliveryEvents: 0,
		deletedCounters: 0,
		deletedThreads: 0,
		deletedSendRecords: 0,
		deletedSuppressionTracking: 0,
		deletedRawMimeBlobs: 0,
		deletedAttachmentBlobs: 0,
		blobDeleteErrors: 0,
		authority: 'dedicated',
		warnings: [],
	}
	const addMessageDelete = (batch: {
		deletedMessages: number
		deletedRawMimeBlobs: number
		deletedAttachmentBlobs: number
		blobDeleteErrors: number
	}) => {
		result.deletedMessages += batch.deletedMessages
		result.deletedRawMimeBlobs += batch.deletedRawMimeBlobs
		result.deletedAttachmentBlobs += batch.deletedAttachmentBlobs
		result.blobDeleteErrors += batch.blobDeleteErrors
	}

	let ageCursor: SystemEmailMessageCursor | null = null
	let selectedInBatch = 0
	do {
		const oldMessages: ReadonlyArray<typeof MessageIdRow.Type> =
			yield* listSystemEmailMessagesEffect(d1, {
				before: cutoffIso,
				cursor: ageCursor,
				limit: systemEmailLimits.pruneBatchSize,
			})
		selectedInBatch = oldMessages.length
		const lastMessage = oldMessages.at(-1)
		if (!lastMessage) break
		ageCursor = { createdAt: lastMessage.created_at, id: lastMessage.id }
		addMessageDelete(
			yield* deleteSystemEmailMessagesByIdsEffect(d1, {
				db: input.db,
				blobs: input.blobs,
				messageIds: oldMessages.map((message) => message.id),
			}),
		)
	} while (
		selectedInBatch >= systemEmailLimits.pruneBatchSize &&
		(yield* withinBudget)
	)

	const overCapMessages = yield* listSystemEmailMessagesEffect(d1, {
		offset: systemEmailLimits.maxStoredMessages,
		limit: systemEmailLimits.pruneBatchSize,
	})
	addMessageDelete(
		yield* deleteSystemEmailMessagesByIdsEffect(d1, {
			db: input.db,
			blobs: input.blobs,
			messageIds: overCapMessages.map((message) => message.id),
		}),
	)

	let deletedEventsInBatch = 0
	do {
		const eventIds = (yield* d1.all(
			'system_email_delivery_events.list_expired',
			IdRow,
			sql(
				`SELECT id
				FROM system_email_delivery_events
				WHERE created_at < ?
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
				cutoffIso,
				systemEmailDeleteIdsMaxParameters,
			),
		)).map((row) => row.id)
		deletedEventsInBatch = eventIds.length
		if (eventIds.length > 0) {
			const placeholders = eventIds.map(() => '?').join(', ')
			const changes = yield* commitSystemEmailAuthorityBatchEffect({
				db: input.db,
				statements: [
					input.db
						.prepare(
							`DELETE FROM system_email_delivery_events
							WHERE id IN (${placeholders})`,
						)
						.bind(...eventIds),
				],
			})
			deletedEventsInBatch = changes[0] ?? 0
		}
		result.deletedDeliveryEvents += deletedEventsInBatch
	} while (
		deletedEventsInBatch >= systemEmailDeleteIdsMaxParameters &&
		(yield* withinBudget)
	)

	result.deletedCounters = (yield* d1.run(
		'system_email_daily_counters.prune',
		sql(`DELETE FROM system_email_daily_counters WHERE day < ?`, cutoffDay),
	)).changes
	let deletedInBatch = 0
	do {
		deletedInBatch = yield* pruneSystemEmailSendsEffect(d1, {
			now,
			limit: systemEmailLimits.pruneBatchSize,
		})
		result.deletedSendRecords += deletedInBatch
	} while (
		deletedInBatch >= systemEmailLimits.pruneBatchSize &&
		(yield* withinBudget)
	)
	do {
		deletedInBatch = yield* pruneRecipientSuppressionTrackingEffect(d1, {
			now,
			limit: systemEmailLimits.pruneBatchSize,
		})
		result.deletedSuppressionTracking += deletedInBatch
	} while (
		deletedInBatch >= systemEmailLimits.pruneBatchSize &&
		(yield* withinBudget)
	)

	if (yield* withinBudget) {
		const threadIds = (yield* d1.all(
			'system_email_threads.list_orphaned',
			IdRow,
			sql(
				`SELECT id FROM system_email_threads
				WHERE NOT EXISTS (
						SELECT 1 FROM system_email_messages
						WHERE system_email_messages.thread_id =
							system_email_threads.id
					)
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
				systemEmailDeleteIdsMaxParameters,
			),
		)).map((row) => row.id)
		if (threadIds.length === 0) return result
		const placeholders = threadIds.map(() => '?').join(', ')
		const changes = yield* commitSystemEmailAuthorityBatchEffect({
			db: input.db,
			statements: [
				input.db
					.prepare(
						`DELETE FROM system_email_threads
						WHERE id IN (${placeholders})`,
					)
					.bind(...threadIds),
			],
		})
		result.deletedThreads += changes[0] ?? 0
	}
	return result
})

/** Promise edge for tests and callers outside the slice. */
export const pruneSystemEmailRetentionViaEffect = (
	input: Parameters<typeof pruneSystemEmailRetention>[0],
) =>
	Effect.runPromise(
		pruneSystemEmailRetentionEffect(input).pipe(
			Effect.provide(observabilityLayer),
		),
	)
