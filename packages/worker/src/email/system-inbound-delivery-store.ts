import { sqlSourcesOf, nextState } from '@kody-internal/shared/state-machine.ts'
import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'
import { inboundDeliveryState } from './inbound-delivery-state.ts'
import { loadPostalMime } from '#worker/postal-mime-load.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	getSystemEmailMessageById,
	insertSystemEmailAttachments,
	listSystemEmailAttachments,
} from './system-email-graph-store.ts'
import {
	InboundDeliveryLeaseLostError,
	inboundDeliveryDedupeWindowMs,
	parseInboundDeliveryDetailJson,
	staleInboundDeliveryAgeMs,
	type InboundDelivery,
} from './inbound-delivery.ts'
import {
	inboundOrphanVerificationMs,
	inboundReconciliationRetryMs,
	inboundStorageLeaseMs,
} from './inbound-delivery-transitions.ts'
import type { SystemEmailLocal } from './system-email.ts'
import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'
import {
	commitSystemInboundEventMutation,
	commitSystemInboundEventMutations,
} from './system-inbound-delivery-transaction.ts'
import {
	systemInboundDedupePointerId,
	systemInboundDedupeProvider,
	systemInboundProvider,
} from './system-inbound-dedupe.ts'

export {
	claimSystemInboundSubscriptionEffect,
	completeSystemInboundSubscriptionEffect,
	failSystemInboundSubscriptionEffect,
	listDueSystemInboundEffects,
	listSystemInboundUsageRows,
	recordSystemInboundUsageEffect,
} from './system-inbound-effect-store.ts'
export { recordBoundedSystemEmailRejection } from './system-inbound-rejection-store.ts'
export {
	systemInboundDeletedRejectionReason,
	systemInboundDedupePointerId,
	systemInboundDedupeProvider,
	systemInboundProvider,
} from './system-inbound-dedupe.ts'

const staleBatchSize = 20

type DeliveryRow = {
	event_type: string
	detail_json: string
}

async function assertSystemDelivery(db: D1Database, delivery: InboundDelivery) {
	await assertSystemEmailGraphAuthority(db)
	if (delivery.userId !== systemEmailOwnerId) {
		throw new Error('System inbound delivery writes require system:email.')
	}
}

function parseDelivery(row: DeliveryRow | null): InboundDelivery | null {
	return parseInboundDeliveryDetailJson(row?.detail_json)
}

const deliveryStoringToPendingGuard = sqlSourcesOf(
	inboundDeliveryState,
	'RELEASE_LEASE',
	['storing'],
)
const deliveryCleaningToOrphanCleanedGuard = sqlSourcesOf(
	inboundDeliveryState,
	'COMPLETE_CLEANUP',
	['cleaning'],
)
const deliveryPendingToStoringGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_STORAGE',
	['pending'],
)
const deliveryStoringToStoringGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_STORAGE',
	['storing'],
)
const deliveryReceivedToStoringGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_STORAGE',
	['received'],
)
const deliveryStoringToReceivedGuard = sqlSourcesOf(
	inboundDeliveryState,
	'RECEIVE',
	['storing'],
)
const deliveryPendingToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['pending'],
)
const deliveryStoringToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['storing'],
)
const deliveryCleaningToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['cleaning'],
)
const deliveryOrphanCleanedToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['orphan-cleaned'],
)

export function systemInboundDedupeExpiry(now: Date) {
	return new Date(now.getTime() + inboundDeliveryDedupeWindowMs).toISOString()
}

export async function getSystemInboundDelivery(input: {
	db: D1Database
	deliveryId: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM system_email_delivery_events
			WHERE id = ? AND provider = ?
			LIMIT 1`,
		)
		.bind(input.deliveryId, systemInboundProvider)
		.first<DeliveryRow>()
	return parseDelivery(row)
}

export async function getSystemInboundDeliveryWindow(input: {
	db: D1Database
	fingerprint: string
	now: Date
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM system_email_delivery_events
			WHERE id = ? AND provider = ? AND dedupe_expires_at > ?
			LIMIT 1`,
		)
		.bind(
			systemInboundDedupePointerId(input.fingerprint),
			systemInboundDedupeProvider,
			input.now.toISOString(),
		)
		.first<DeliveryRow>()
	return parseDelivery(row)
}

export async function claimSystemInboundDeliveryWindow(input: {
	db: D1Database
	delivery: InboundDelivery
	now: Date
}) {
	await assertSystemDelivery(input.db, input.delivery)
	const pointerId = systemInboundDedupePointerId(input.delivery.fingerprint)
	nextState(inboundDedupePointerState, 'pending', { type: 'RESET_WINDOW' })
	nextState(inboundDedupePointerState, 'rejected', { type: 'RESET_WINDOW' })
	try {
		await commitSystemInboundEventMutation({
			db: input.db,
			eventId: pointerId,
			dedicated: input.db
				.prepare(
					`INSERT INTO system_email_delivery_events (
					id, message_id, inbox_id, event_type, provider, provider_event_id,
					detail_json, created_at, state, fingerprint, dedupe_expires_at,
					updated_at
				) VALUES (?, NULL, ?, 'receive_started', ?, ?, ?, ?, 'pending', ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					inbox_id = excluded.inbox_id,
					detail_json = excluded.detail_json,
					created_at = excluded.created_at,
					state = excluded.state,
					fingerprint = excluded.fingerprint,
					dedupe_expires_at = excluded.dedupe_expires_at,
					updated_at = excluded.updated_at
				WHERE system_email_delivery_events.dedupe_expires_at <= ?`,
				)
				.bind(
					pointerId,
					input.delivery.inboxId,
					systemInboundDedupeProvider,
					pointerId,
					JSON.stringify(input.delivery),
					input.now.toISOString(),
					input.delivery.fingerprint,
					input.delivery.dedupeExpiresAt,
					input.now.toISOString(),
					input.now.toISOString(),
				),
		})
	} catch (error) {
		const committed = await getSystemInboundDeliveryPointer({
			db: input.db,
			eventId: pointerId,
			provider: systemInboundDedupeProvider,
		}).catch(() => null)
		if (!committed) throw error
		console.warn(
			'system-inbound-dedupe-window-claim-recovered',
			pointerId,
			error,
		)
		return committed
	}
	const claimed = await getSystemInboundDeliveryPointer({
		db: input.db,
		eventId: pointerId,
		provider: systemInboundDedupeProvider,
	})
	if (!claimed) {
		throw new Error('Failed to resolve the system inbound dedupe window.')
	}
	return claimed
}

async function getSystemInboundDeliveryPointer(input: {
	db: D1Database
	eventId: string
	provider: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM system_email_delivery_events
			WHERE id = ? AND provider = ?
			LIMIT 1`,
		)
		.bind(input.eventId, input.provider)
		.first<DeliveryRow>()
	return parseDelivery(row)
}

export async function chargeSystemInboundDeliveryOnce(input: {
	db: D1Database
	delivery: InboundDelivery
	localPart: SystemEmailLocal
	limit: number
	now: Date
}) {
	await assertSystemDelivery(input.db, input.delivery)
	const refusedWindow = await getSystemInboundDeliveryWindow({
		db: input.db,
		fingerprint: input.delivery.fingerprint,
		now: input.now,
	})
	const existing = await getSystemInboundDelivery({
		db: input.db,
		deliveryId: input.delivery.deliveryId,
	})
	if (refusedWindow?.state === 'rejected') {
		// A rejected pointer blocks new charges and the deleted message's own
		// delivery. An older charged row for the same fingerprint (window was
		// reused then the newer copy deleted) may still resume.
		const refusedOwnsThis = refusedWindow.messageId === input.delivery.messageId
		if (refusedOwnsThis || !existing) {
			return { delivery: refusedWindow, overLimit: false as const }
		}
	}
	if (existing) return { delivery: existing, overLimit: false as const }
	const pointerId = systemInboundDedupePointerId(input.delivery.fingerprint)
	const operationToken = crypto.randomUUID()
	const operationTimestamp = input.now.toISOString()
	try {
		await commitSystemInboundEventMutation({
			db: input.db,
			eventId: input.delivery.deliveryId,
			before: [
				input.db
					.prepare(
						`INSERT INTO system_email_daily_counters (
					local_part, day, count, updated_at, operation_token
				)
				SELECT ?, ?, 1, ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM system_email_delivery_events WHERE id = ?
				)
				AND NOT EXISTS (
					SELECT 1 FROM system_email_delivery_events
					WHERE id = ? AND provider = ? AND state = 'rejected'
				)
				ON CONFLICT(local_part, day) DO UPDATE SET
					count = count + 1, updated_at = excluded.updated_at,
					operation_token = excluded.operation_token
				WHERE count + 1 <= ?
					AND NOT EXISTS (
						SELECT 1 FROM system_email_delivery_events WHERE id = ?
					)
					AND NOT EXISTS (
						SELECT 1 FROM system_email_delivery_events
						WHERE id = ? AND provider = ? AND state = 'rejected'
					)`,
					)
					.bind(
						input.localPart,
						input.delivery.quotaDay,
						operationTimestamp,
						operationToken,
						input.delivery.deliveryId,
						pointerId,
						systemInboundDedupeProvider,
						input.limit,
						input.delivery.deliveryId,
						pointerId,
						systemInboundDedupeProvider,
					),
			],
			dedicated: input.db
				.prepare(
					`INSERT OR IGNORE INTO system_email_delivery_events (
					id, message_id, inbox_id, event_type, provider, provider_event_id,
					detail_json, created_at, state, fingerprint, dedupe_expires_at,
					updated_at
				)
				SELECT ?, NULL, ?, 'receive_started', ?, ?, ?, ?, 'pending', ?, ?, ?
				WHERE EXISTS (
					SELECT 1 FROM system_email_daily_counters
					WHERE local_part = ? AND day = ? AND operation_token = ?
				)
				AND NOT EXISTS (
					SELECT 1 FROM system_email_delivery_events
					WHERE id = ? AND provider = ? AND state = 'rejected'
				)`,
				)
				.bind(
					input.delivery.deliveryId,
					input.delivery.inboxId,
					systemInboundProvider,
					input.delivery.deliveryId,
					JSON.stringify(input.delivery),
					input.now.toISOString(),
					input.delivery.fingerprint,
					input.delivery.dedupeExpiresAt,
					input.now.toISOString(),
					input.localPart,
					input.delivery.quotaDay,
					operationToken,
					pointerId,
					systemInboundDedupeProvider,
				),
		})
	} catch (error) {
		const committed = await getSystemInboundDelivery({
			db: input.db,
			deliveryId: input.delivery.deliveryId,
		}).catch(() => null)
		if (!committed) throw error
		return { delivery: committed, overLimit: false as const }
	}
	const committed = await getSystemInboundDelivery({
		db: input.db,
		deliveryId: input.delivery.deliveryId,
	})
	if (committed) return { delivery: committed, overLimit: false as const }
	const refused = await getSystemInboundDeliveryWindow({
		db: input.db,
		fingerprint: input.delivery.fingerprint,
		now: input.now,
	})
	if (refused?.state === 'rejected') {
		return { delivery: refused, overLimit: false as const }
	}
	return { delivery: null, overLimit: true as const }
}

export async function claimSystemInboundDeliveryStorage(input: {
	db: D1Database
	delivery: InboundDelivery
	expectedAttachmentCount: number
	usageStartedAt?: string
	now?: Date
}) {
	await assertSystemDelivery(input.db, input.delivery)
	const now = input.now ?? new Date()
	const storageLease = crypto.randomUUID()
	const storageLeaseAt = now.toISOString()
	const expiredBefore = new Date(
		now.getTime() - inboundStorageLeaseMs,
	).toISOString()
	const { dedicatedResult } = await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.delivery.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET event_type = 'receive_started', message_id = NULL,
					detail_json = json_set(
						detail_json, '$.state', 'storing', '$.storageLease', ?,
						'$.storageLeaseAt', ?, '$.expectedAttachmentCount', ?,
						'$.usageStartedAt', COALESCE(
							json_extract(detail_json, '$.usageStartedAt'), ?
						)
					),
					state = 'storing', storage_lease = ?, storage_lease_at = ?,
					expected_attachment_count = ?,
					usage_started_at = COALESCE(usage_started_at, ?),
					updated_at = ?
				WHERE id = ? AND (
					state IN ${deliveryPendingToStoringGuard}
					OR (
						state IN ${deliveryStoringToStoringGuard}
						AND (storage_lease_at IS NULL OR storage_lease_at < ?)
					)
					OR (state IN ${deliveryReceivedToStoringGuard} AND NOT EXISTS (
						SELECT 1 FROM system_email_messages
						WHERE id = json_extract(
							system_email_delivery_events.detail_json, '$.messageId'
						)
					))
				)
				AND NOT EXISTS (
					SELECT 1 FROM system_email_delivery_events
					WHERE id = ? AND provider = ? AND state = 'rejected'
						AND json_extract(detail_json, '$.messageId') = ?
				)`,
			)
			.bind(
				storageLease,
				storageLeaseAt,
				input.expectedAttachmentCount,
				input.usageStartedAt ?? null,
				storageLease,
				storageLeaseAt,
				input.expectedAttachmentCount,
				input.usageStartedAt ?? null,
				storageLeaseAt,
				input.delivery.deliveryId,
				expiredBefore,
				systemInboundDedupePointerId(input.delivery.fingerprint),
				systemInboundDedupeProvider,
				input.delivery.messageId,
			),
	})
	const delivery = await getSystemInboundDelivery({
		db: input.db,
		deliveryId: input.delivery.deliveryId,
	})
	return {
		claimed: Number(dedicatedResult?.meta.changes ?? 0) > 0,
		delivery,
	}
}

export async function releaseSystemInboundDeliveryStorage(input: {
	db: D1Database
	delivery: InboundDelivery
}) {
	await assertSystemDelivery(input.db, input.delivery)
	if (!input.delivery.storageLease) return
	await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.delivery.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET detail_json = json_remove(
						json_remove(json_set(detail_json, '$.state', 'pending'),
							'$.storageLease'), '$.storageLeaseAt'
					),
					state = 'pending', storage_lease = NULL, storage_lease_at = NULL,
					updated_at = ?
				WHERE id = ? AND state IN ${deliveryStoringToPendingGuard} AND storage_lease = ?`,
			)
			.bind(
				new Date().toISOString(),
				input.delivery.deliveryId,
				input.delivery.storageLease,
			),
	})
}

export async function markSystemInboundDeliveryRejected(input: {
	db: D1Database
	delivery: InboundDelivery
	reason: string
}) {
	await assertSystemDelivery(input.db, input.delivery)
	if (
		input.delivery.state !== 'received' &&
		input.delivery.state !== 'rejected'
	)
		nextState(inboundDeliveryState, input.delivery.state, { type: 'REJECT' })
	const detail = {
		...input.delivery,
		state: 'rejected' as const,
		rejectionReason: input.reason,
	}
	delete detail.storageLease
	delete detail.storageLeaseAt
	const expectedLease = input.delivery.storageLease ?? null
	const { dedicatedResult } = await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.delivery.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET event_type = 'rejected', detail_json = ?, state = 'rejected',
					storage_lease = NULL, storage_lease_at = NULL, updated_at = ?
				WHERE id = ? AND event_type = 'receive_started'
					AND state = ? AND fingerprint = ?
					AND ((? IS NULL AND storage_lease IS NULL) OR storage_lease = ?)`,
			)
			.bind(
				JSON.stringify(detail),
				new Date().toISOString(),
				input.delivery.deliveryId,
				input.delivery.state,
				input.delivery.fingerprint,
				expectedLease,
				expectedLease,
			),
	})
	if (Number(dedicatedResult?.meta.changes ?? 0) > 0) return true
	const current = await getSystemInboundDelivery({
		db: input.db,
		deliveryId: input.delivery.deliveryId,
	})
	if (current?.state === 'rejected') return true
	if (
		current?.state === 'received' &&
		(await getSystemEmailMessageById({
			db: input.db,
			messageId: current.messageId,
		}))
	) {
		return false
	}
	throw new InboundDeliveryLeaseLostError(
		'System inbound rejection lost a state race.',
	)
}

export async function markSystemInboundDeliveryReceived(input: {
	db: D1Database
	delivery: InboundDelivery
	usageDurationMs: number
	usageMonth: string
	usageBytes: number
}) {
	await assertSystemDelivery(input.db, input.delivery)
	if (!input.delivery.storageLease) {
		throw new InboundDeliveryLeaseLostError(
			'System inbound finalization requires a storage lease.',
		)
	}
	nextState(inboundDeliveryState, 'storing', { type: 'RECEIVE' })
	if (input.delivery.subscriptionEffectState)
		nextState(
			inboundSubscriptionEffectState,
			input.delivery.subscriptionEffectState,
			{ type: 'RESET' },
		)
	const detail: InboundDelivery = {
		...input.delivery,
		state: 'received',
		finalizationToken: input.delivery.storageLease,
		subscriptionEffectState: 'pending',
		usageDurationMs: Math.max(0, Math.round(input.usageDurationMs)),
		usageMonth: input.usageMonth,
		usageBytes: Math.max(0, Math.round(input.usageBytes)),
	}
	delete detail.storageLease
	delete detail.storageLeaseAt
	const now = new Date().toISOString()
	const { dedicatedResult } = await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.delivery.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET message_id = ?, event_type = 'received', detail_json = ?,
					needs_effect_reconcile = 1, state = 'received',
					storage_lease = NULL, storage_lease_at = NULL,
					finalization_token = ?, usage_month = ?, usage_bytes = ?,
					usage_duration_ms = ?, subscription_effect_state = 'pending',
					updated_at = ?
				WHERE id = ? AND state IN ${deliveryStoringToReceivedGuard} AND storage_lease = ?`,
			)
			.bind(
				input.delivery.messageId,
				JSON.stringify(detail),
				input.delivery.storageLease,
				detail.usageMonth,
				detail.usageBytes,
				detail.usageDurationMs,
				now,
				input.delivery.deliveryId,
				input.delivery.storageLease,
			),
	})
	if (Number(dedicatedResult?.meta.changes ?? 0) > 0) return detail
	const current = await getSystemInboundDelivery({
		db: input.db,
		deliveryId: input.delivery.deliveryId,
	})
	if (current?.state === 'received') return current
	throw new InboundDeliveryLeaseLostError(
		'System inbound storage lease was lost before finalization.',
	)
}

export async function pruneSystemExpiredInboundDedupePointers(input: {
	db: D1Database
	now?: Date
	limit?: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const now = input.now ?? new Date()
	const rows = await input.db
		.prepare(
			`SELECT id FROM system_email_delivery_events
			WHERE provider = ? AND dedupe_expires_at <= ?
			ORDER BY created_at ASC, id ASC LIMIT ?`,
		)
		.bind(systemInboundDedupeProvider, now.toISOString(), input.limit ?? 20)
		.all<{ id: string }>()
	const ids = (rows.results ?? []).map((row) => row.id)
	if (ids.length === 0) return 0
	const mutations = ids.map((id) => ({
		eventId: id,
		dedicated: input.db
			.prepare(
				`DELETE FROM system_email_delivery_events
					WHERE id = ? AND provider = ? AND dedupe_expires_at <= ?`,
			)
			.bind(id, systemInboundDedupeProvider, now.toISOString()),
	}))
	const { mutationResults } = await commitSystemInboundEventMutations({
		db: input.db,
		mutations,
	})
	return mutationResults.reduce(
		(total, result) => total + Number(result.dedicated?.meta.changes ?? 0),
		0,
	)
}

function parsedAttachmentSize(
	content: string | ArrayBuffer | Uint8Array<ArrayBufferLike>,
) {
	return typeof content === 'string'
		? new TextEncoder().encode(content).byteLength
		: content.byteLength
}

async function deferSystemReconciliation(input: {
	db: D1Database
	deliveryId: string
	now: Date
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const retryAt = new Date(
		input.now.getTime() + inboundReconciliationRetryMs,
	).toISOString()
	await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET detail_json = json_set(detail_json, '$.reconcileAfter', ?),
					reconcile_after = ?, updated_at = ?
				WHERE id = ? AND event_type = 'receive_started'`,
			)
			.bind(retryAt, retryAt, input.now.toISOString(), input.deliveryId),
	})
}

async function recoverSystemDelivery(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: InboundDelivery
	now: Date
}) {
	const message = await getSystemEmailMessageById({
		db: input.db,
		messageId: input.delivery.messageId,
	})
	if (!message?.rawMimeKey) return false
	if (
		message.rawMimeKey !==
		emailRawMimeKey(systemEmailOwnerId, input.delivery.messageId)
	) {
		throw new Error('System inbound raw MIME key is outside its namespace.')
	}
	const object = await input.blobs.get(message.rawMimeKey)
	if (!object) return false
	const PostalMime = await loadPostalMime()
	const parsed = await PostalMime.parse(await object.text(), {
		attachmentEncoding: 'arraybuffer',
	})
	const claim = await claimSystemInboundDeliveryStorage({
		db: input.db,
		delivery: input.delivery,
		expectedAttachmentCount: parsed.attachments.length,
		usageStartedAt: input.delivery.usageStartedAt,
		now: input.now,
	})
	if (!claim.claimed || !claim.delivery?.storageLease) {
		return claim.delivery?.state === 'received'
	}
	try {
		await insertSystemEmailAttachments({
			db: input.db,
			messageId: message.id,
			ignoreConflicts: true,
			inboundDeliveryFence: {
				deliveryId: claim.delivery.deliveryId,
				storageLease: claim.delivery.storageLease,
			},
			attachments: parsed.attachments.map((attachment, index) => ({
				id: `${message.id}:attachment:${index}`,
				filename: attachment.filename,
				contentType: attachment.mimeType,
				contentId: attachment.contentId ?? null,
				disposition: attachment.disposition,
				size: parsedAttachmentSize(attachment.content),
				storageKind: 'raw-mime',
				storageKey: null,
			})),
		})
		const attachments = await listSystemEmailAttachments({
			db: input.db,
			messageId: message.id,
		})
		if (attachments.length !== parsed.attachments.length) {
			throw new InboundDeliveryLeaseLostError(
				'System attachment recovery was incomplete.',
			)
		}
		await markSystemInboundDeliveryReceived({
			db: input.db,
			delivery: claim.delivery,
			usageDurationMs: claim.delivery.usageStartedAt
				? input.now.getTime() - Date.parse(claim.delivery.usageStartedAt)
				: 0,
			usageMonth: (message.receivedAt ?? message.createdAt).slice(0, 7),
			usageBytes: message.rawSize ?? 0,
		})
		return true
	} catch (error) {
		await releaseSystemInboundDeliveryStorage({
			db: input.db,
			delivery: claim.delivery,
		}).catch(() => undefined)
		throw error
	}
}

export async function reconcileSystemStaleInboundDeliveries(input: {
	db: D1Database
	blobs: R2Bucket
	now?: Date
	deadlineMs?: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - staleInboundDeliveryAgeMs,
	).toISOString()
	const leaseExpiredBefore = new Date(
		now.getTime() - inboundStorageLeaseMs,
	).toISOString()
	const rows = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM system_email_delivery_events
			WHERE provider = ? AND event_type = 'receive_started'
				AND created_at < ?
				AND (reconcile_after IS NULL OR reconcile_after <= ?)
				AND (
					state = 'pending'
					OR (
						state = 'storing'
						AND (storage_lease_at IS NULL OR storage_lease_at < ?)
					)
					OR (
						state = 'cleaning'
						AND (cleanup_lease_at IS NULL OR cleanup_lease_at < ?)
					)
					OR (state = 'orphan-cleaned' AND cleanup_retry_at <= ?)
				)
			ORDER BY created_at ASC, id ASC LIMIT ?`,
		)
		.bind(
			systemInboundProvider,
			cutoff,
			now.toISOString(),
			leaseExpiredBefore,
			leaseExpiredBefore,
			now.toISOString(),
			staleBatchSize,
		)
		.all<DeliveryRow>()
	let recovered = 0
	let cleaned = 0
	let budgetExhausted = false
	for (const row of rows.results ?? []) {
		if (input.deadlineMs != null && Date.now() >= input.deadlineMs) {
			budgetExhausted = true
			break
		}
		const delivery = parseDelivery(row)
		if (!delivery || delivery.userId !== systemEmailOwnerId) continue
		const message = await getSystemEmailMessageById({
			db: input.db,
			messageId: delivery.messageId,
		})
		if (message) {
			try {
				if (
					await recoverSystemDelivery({
						db: input.db,
						blobs: input.blobs,
						delivery,
						now,
					})
				) {
					recovered += 1
				} else {
					await deferSystemReconciliation({
						db: input.db,
						deliveryId: delivery.deliveryId,
						now,
					})
				}
			} catch (error) {
				console.warn(
					'inbound-email-partial-delivery-recovery-failed',
					delivery.deliveryId,
					error,
				)
				await deferSystemReconciliation({
					db: input.db,
					deliveryId: delivery.deliveryId,
					now,
				}).catch(() => undefined)
			}
			continue
		}
		const cleanupLease = crypto.randomUUID()
		const { dedicatedResult } = await commitSystemInboundEventMutation({
			db: input.db,
			eventId: delivery.deliveryId,
			dedicated: input.db
				.prepare(
					`UPDATE system_email_delivery_events
					SET state = 'cleaning', cleanup_lease = ?, cleanup_lease_at = ?,
						detail_json = json_set(
							detail_json, '$.state', 'cleaning', '$.cleanupLease', ?,
							'$.cleanupLeaseAt', ?
						), updated_at = ?
					WHERE id = ? AND (
						state IN ${deliveryPendingToCleaningGuard}
						OR (
							state IN ${deliveryStoringToCleaningGuard}
							AND (storage_lease_at IS NULL OR storage_lease_at < ?)
						)
						OR (
							state IN ${deliveryCleaningToCleaningGuard}
							AND (cleanup_lease_at IS NULL OR cleanup_lease_at < ?)
						)
						OR (state IN ${deliveryOrphanCleanedToCleaningGuard} AND cleanup_retry_at <= ?)
					) AND NOT EXISTS (
						SELECT 1 FROM system_email_messages WHERE id = ?
					)`,
				)
				.bind(
					cleanupLease,
					now.toISOString(),
					cleanupLease,
					now.toISOString(),
					now.toISOString(),
					delivery.deliveryId,
					leaseExpiredBefore,
					leaseExpiredBefore,
					now.toISOString(),
					delivery.messageId,
				),
		})
		if (Number(dedicatedResult?.meta.changes ?? 0) === 0) continue
		let deleteFailed = false
		try {
			await input.blobs.delete(delivery.rawMimeKey)
		} catch (error) {
			deleteFailed = true
			console.warn(
				'inbound-email-orphan-blob-delete-failed',
				delivery.rawMimeKey,
				error,
			)
		}
		const retryAt = new Date(
			now.getTime() +
				(deleteFailed
					? inboundReconciliationRetryMs
					: inboundOrphanVerificationMs),
		).toISOString()
		await commitSystemInboundEventMutation({
			db: input.db,
			eventId: delivery.deliveryId,
			dedicated: input.db
				.prepare(
					`UPDATE system_email_delivery_events
					SET state = 'orphan-cleaned', cleanup_lease = NULL,
						cleanup_lease_at = NULL, cleanup_retry_at = ?,
						detail_json = json_remove(
							json_remove(
								json_set(
									detail_json, '$.state', 'orphan-cleaned',
									'$.cleanupRetryAt', ?
								), '$.cleanupLease'
							), '$.cleanupLeaseAt'
						), updated_at = ?
					WHERE id = ? AND state IN ${deliveryCleaningToOrphanCleanedGuard} AND cleanup_lease = ?`,
				)
				.bind(
					retryAt,
					retryAt,
					now.toISOString(),
					delivery.deliveryId,
					cleanupLease,
				),
		})
		if (!deleteFailed) cleaned += 1
	}
	return {
		recovered,
		cleaned,
		...(budgetExhausted ? { budgetExhausted: true as const } : {}),
	}
}
