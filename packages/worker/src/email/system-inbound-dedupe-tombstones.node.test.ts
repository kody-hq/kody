import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type { InboundDelivery } from './inbound-delivery.ts'
import {
	deleteSystemEmailMessageById,
	insertSystemEmailMessage,
} from './system-email-graph-store.ts'
import {
	systemInboundDeletedRejectionReason,
	systemInboundDedupePointerId,
	systemInboundDedupeProvider,
	systemInboundProvider,
} from './system-inbound-dedupe.ts'
import {
	chargeSystemInboundDeliveryOnce,
	claimSystemInboundDeliveryStorage,
	claimSystemInboundDeliveryWindow,
	getSystemInboundDelivery,
	getSystemInboundDeliveryWindow,
	markSystemInboundDeliveryReceived,
} from './system-inbound-delivery-store.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createDedicatedDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite.exec(`
		INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES (
			'system-tombstone-inbox', 'system:email', 'abuse', '', 1,
			'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
		)
	`)
	return sqlite
}

function delivery(
	now: Date,
	overrides: Partial<InboundDelivery> = {},
): InboundDelivery {
	return {
		fingerprint: 'fingerprint-tombstone',
		deliveryId: 'delivery-tombstone',
		messageId: 'message-tombstone',
		threadId: 'thread-tombstone',
		rawMimeKey: 'email-raw:v1:system:email/message-tombstone',
		userId: ownerIdFromStored('system:email'),
		inboxId: 'system-tombstone-inbox',
		recipient: 'abuse@example.com',
		envelopeFrom: 'phish@example.net',
		provider: 'cloudflare-email-routing',
		quotaDay: now.toISOString().slice(0, 10),
		dedupeExpiresAt: new Date(
			now.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
		state: 'pending',
		...overrides,
	}
}

async function storeThroughReceived(input: {
	db: D1Database
	target: InboundDelivery
	now: Date
}) {
	await claimSystemInboundDeliveryWindow({
		db: input.db,
		delivery: input.target,
		now: input.now,
	})
	const charged = (
		await chargeSystemInboundDeliveryOnce({
			db: input.db,
			delivery: input.target,
			localPart: 'abuse',
			limit: 100,
			now: input.now,
		})
	).delivery!
	const claimed = (
		await claimSystemInboundDeliveryStorage({
			db: input.db,
			delivery: charged,
			expectedAttachmentCount: 0,
			now: input.now,
		})
	).delivery!
	await insertSystemEmailMessage({
		db: input.db,
		inboundDeliveryFence: {
			deliveryId: claimed.deliveryId,
			storageLease: claimed.storageLease!,
		},
		message: {
			id: input.target.messageId,
			inboxId: input.target.inboxId,
			fromAddress: input.target.envelopeFrom,
			processingStatus: 'stored',
			rawMimeKey: input.target.rawMimeKey,
			receivedAt: input.now.toISOString(),
		},
	})
	await markSystemInboundDeliveryReceived({
		db: input.db,
		delivery: claimed,
		usageDurationMs: 8,
		usageMonth: input.now.toISOString().slice(0, 7),
		usageBytes: 16,
	})
	return claimed
}

async function storeThroughMessageInsert(input: {
	db: D1Database
	target: InboundDelivery
	now: Date
}) {
	await claimSystemInboundDeliveryWindow({
		db: input.db,
		delivery: input.target,
		now: input.now,
	})
	const charged = (
		await chargeSystemInboundDeliveryOnce({
			db: input.db,
			delivery: input.target,
			localPart: 'abuse',
			limit: 100,
			now: input.now,
		})
	).delivery!
	const claimed = (
		await claimSystemInboundDeliveryStorage({
			db: input.db,
			delivery: charged,
			expectedAttachmentCount: 0,
			now: input.now,
		})
	).delivery!
	await insertSystemEmailMessage({
		db: input.db,
		inboundDeliveryFence: {
			deliveryId: claimed.deliveryId,
			storageLease: claimed.storageLease!,
		},
		message: {
			id: input.target.messageId,
			inboxId: input.target.inboxId,
			fromAddress: input.target.envelopeFrom,
			processingStatus: 'stored',
			rawMimeKey: input.target.rawMimeKey,
			receivedAt: input.now.toISOString(),
		},
	})
	return claimed
}

test('system email delete tombstones the inbound pointer and refuses a matching re-charge', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-10-08T00:00:00.000Z')
	const target = delivery(now)
	await storeThroughReceived({ db, target, now })

	await deleteSystemEmailMessageById({
		db,
		blobs: { delete: async () => undefined } as unknown as R2Bucket,
		messageId: target.messageId,
	})

	const window = await getSystemInboundDeliveryWindow({
		db,
		fingerprint: target.fingerprint,
		now,
	})
	expect(window).toMatchObject({
		state: 'rejected',
		rejectionReason: systemInboundDeletedRejectionReason,
		deliveryId: target.deliveryId,
	})
	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: target.deliveryId,
		}),
	).toBeNull()
	const pointerRow = sqlite
		.prepare(
			`SELECT id, state, event_type, message_id
			FROM system_email_delivery_events
			WHERE id = ?`,
		)
		.get(systemInboundDedupePointerId(target.fingerprint)) as {
		id: string
		state: string
		event_type: string
		message_id: string | null
	}
	expect(pointerRow).toEqual({
		id: systemInboundDedupePointerId(target.fingerprint),
		state: 'rejected',
		event_type: 'rejected',
		message_id: null,
	})

	const reclaimed = await claimSystemInboundDeliveryWindow({
		db,
		delivery: { ...target, state: 'pending' },
		now,
	})
	expect(reclaimed).toMatchObject({
		state: 'rejected',
		rejectionReason: systemInboundDeletedRejectionReason,
	})
	const recharge = await chargeSystemInboundDeliveryOnce({
		db,
		delivery: target,
		localPart: 'abuse',
		limit: 100,
		now,
	})
	expect(recharge).toEqual({
		delivery: expect.objectContaining({
			state: 'rejected',
			rejectionReason: systemInboundDeletedRejectionReason,
		}),
		overLimit: false,
	})
	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: target.deliveryId,
		}),
	).toBeNull()
	const counter = sqlite
		.prepare(
			`SELECT count FROM system_email_daily_counters
			WHERE local_part = 'abuse' AND day = ?`,
		)
		.get(target.quotaDay) as { count: number }
	expect(counter.count).toBe(1)
})

test('deleting an older copy does not tombstone a newer pointer for the same fingerprint', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const monday = new Date('2026-10-05T12:00:00.000Z')
	const thursday = new Date('2026-10-08T12:00:00.000Z')
	const fingerprint = 'fingerprint-shared-mime'
	const older = delivery(monday, {
		fingerprint,
		deliveryId: 'delivery-older',
		messageId: 'message-older',
		rawMimeKey: 'email-raw:v1:system:email/message-older',
		dedupeExpiresAt: new Date(
			monday.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
	})
	await storeThroughReceived({ db, target: older, now: monday })

	// Expire the Monday pointer so Thursday can claim the same fingerprint id.
	sqlite
		.prepare(
			`UPDATE system_email_delivery_events
			SET dedupe_expires_at = ?
			WHERE id = ? AND provider = ?`,
		)
		.run(
			new Date(thursday.getTime() - 1).toISOString(),
			systemInboundDedupePointerId(fingerprint),
			systemInboundDedupeProvider,
		)

	const newer = delivery(thursday, {
		fingerprint,
		deliveryId: 'delivery-newer',
		messageId: 'message-newer',
		rawMimeKey: 'email-raw:v1:system:email/message-newer',
		quotaDay: thursday.toISOString().slice(0, 10),
		dedupeExpiresAt: new Date(
			thursday.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
	})
	await storeThroughReceived({ db, target: newer, now: thursday })

	await deleteSystemEmailMessageById({
		db,
		blobs: { delete: async () => undefined } as unknown as R2Bucket,
		messageId: older.messageId,
	})

	const window = await getSystemInboundDeliveryWindow({
		db,
		fingerprint,
		now: thursday,
	})
	// Pointer detail stays at the claim-time pending snapshot; only the charged
	// event moves to received. Deleting the older copy must not reject it.
	expect(window).toMatchObject({
		state: 'pending',
		deliveryId: newer.deliveryId,
		messageId: newer.messageId,
	})
	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: newer.deliveryId,
		}),
	).toMatchObject({
		state: 'received',
		messageId: newer.messageId,
	})
	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_messages WHERE id = ?`)
			.get(newer.messageId),
	).toEqual({ id: newer.messageId })
})

test('delete fences an unlinked charged event so an in-flight retry cannot recreate mail', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-10-08T00:00:00.000Z')
	const target = delivery(now)
	const claimed = await storeThroughMessageInsert({ db, target, now })

	const chargedBeforeDelete = sqlite
		.prepare(
			`SELECT id, message_id, state FROM system_email_delivery_events
			WHERE id = ? AND provider = ?`,
		)
		.get(target.deliveryId, systemInboundProvider) as {
		id: string
		message_id: string | null
		state: string
	}
	expect(chargedBeforeDelete).toMatchObject({
		id: target.deliveryId,
		message_id: null,
		state: 'storing',
	})

	await deleteSystemEmailMessageById({
		db,
		blobs: { delete: async () => undefined } as unknown as R2Bucket,
		messageId: target.messageId,
	})

	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: target.deliveryId,
		}),
	).toBeNull()
	const window = await getSystemInboundDeliveryWindow({
		db,
		fingerprint: target.fingerprint,
		now,
	})
	expect(window).toMatchObject({
		state: 'rejected',
		rejectionReason: systemInboundDeletedRejectionReason,
	})

	const retryClaim = await claimSystemInboundDeliveryStorage({
		db,
		delivery: claimed,
		expectedAttachmentCount: 0,
		now,
	})
	expect(retryClaim.claimed).toBe(false)
	expect(retryClaim.delivery).toBeNull()

	await expect(
		insertSystemEmailMessage({
			db,
			inboundDeliveryFence: {
				deliveryId: claimed.deliveryId,
				storageLease: claimed.storageLease!,
			},
			message: {
				id: target.messageId,
				inboxId: target.inboxId,
				fromAddress: target.envelopeFrom,
				processingStatus: 'stored',
				rawMimeKey: target.rawMimeKey,
				receivedAt: now.toISOString(),
			},
		}),
	).rejects.toThrow(/storage lease was lost/)
	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_messages WHERE id = ?`)
			.get(target.messageId),
	).toBeUndefined()
})

test('charge on a fresh quota day does not consume quota for a rejected pointer', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-10-09T00:00:00.000Z')
	const target = delivery(now, {
		deliveryId: 'delivery-fresh-day-retry',
		messageId: 'message-fresh-day-retry',
		rawMimeKey: 'email-raw:v1:system:email/message-fresh-day-retry',
	})
	// Seed a rejected pointer whose window read is already expired so
	// getSystemInboundDeliveryWindow returns null, but the counter INSERT still
	// sees state=rejected (the race Devin described after the JS read).
	const pointerId = systemInboundDedupePointerId(target.fingerprint)
	sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, inbox_id, event_type, provider, provider_event_id,
				detail_json, created_at, state, fingerprint, dedupe_expires_at,
				updated_at
			) VALUES (?, NULL, ?, 'rejected', ?, ?, ?, ?, 'rejected', ?, ?, ?)`,
		)
		.run(
			pointerId,
			target.inboxId,
			systemInboundDedupeProvider,
			pointerId,
			JSON.stringify({
				...target,
				state: 'rejected',
				rejectionReason: systemInboundDeletedRejectionReason,
			}),
			now.toISOString(),
			target.fingerprint,
			new Date(now.getTime() - 1).toISOString(),
			now.toISOString(),
		)

	expect(
		await getSystemInboundDeliveryWindow({
			db,
			fingerprint: target.fingerprint,
			now,
		}),
	).toBeNull()

	const recharge = await chargeSystemInboundDeliveryOnce({
		db,
		delivery: target,
		localPart: 'abuse',
		limit: 100,
		now,
	})
	expect(recharge.delivery).toBeNull()
	expect(
		sqlite
			.prepare(
				`SELECT count FROM system_email_daily_counters
				WHERE local_part = 'abuse' AND day = ?`,
			)
			.get(target.quotaDay),
	).toBeUndefined()
	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: target.deliveryId,
		}),
	).toBeNull()
})

test('deleting a newer copy does not block storage claim for an older incomplete delivery', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const monday = new Date('2026-10-05T12:00:00.000Z')
	const thursday = new Date('2026-10-08T12:00:00.000Z')
	const fingerprint = 'fingerprint-older-recovery'
	const older = delivery(monday, {
		fingerprint,
		deliveryId: 'delivery-older-incomplete',
		messageId: 'message-older-incomplete',
		rawMimeKey: 'email-raw:v1:system:email/message-older-incomplete',
		dedupeExpiresAt: new Date(
			monday.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
	})
	const olderClaimed = await storeThroughMessageInsert({
		db,
		target: older,
		now: monday,
	})
	// Leave the older delivery in storing with an expired lease (stale recovery).
	sqlite
		.prepare(
			`UPDATE system_email_delivery_events
			SET storage_lease_at = ?
			WHERE id = ?`,
		)
		.run(
			new Date(thursday.getTime() - 60 * 60 * 1000).toISOString(),
			older.deliveryId,
		)
	sqlite
		.prepare(
			`UPDATE system_email_delivery_events
			SET dedupe_expires_at = ?
			WHERE id = ? AND provider = ?`,
		)
		.run(
			new Date(thursday.getTime() - 1).toISOString(),
			systemInboundDedupePointerId(fingerprint),
			systemInboundDedupeProvider,
		)

	const newer = delivery(thursday, {
		fingerprint,
		deliveryId: 'delivery-newer-deleted',
		messageId: 'message-newer-deleted',
		rawMimeKey: 'email-raw:v1:system:email/message-newer-deleted',
		quotaDay: thursday.toISOString().slice(0, 10),
		dedupeExpiresAt: new Date(
			thursday.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
	})
	await storeThroughReceived({ db, target: newer, now: thursday })
	await deleteSystemEmailMessageById({
		db,
		blobs: { delete: async () => undefined } as unknown as R2Bucket,
		messageId: newer.messageId,
	})

	const recovered = await claimSystemInboundDeliveryStorage({
		db,
		delivery: olderClaimed,
		expectedAttachmentCount: 0,
		now: thursday,
	})
	expect(recovered.claimed).toBe(true)
	expect(recovered.delivery).toMatchObject({
		deliveryId: older.deliveryId,
		messageId: older.messageId,
		state: 'storing',
	})
})

test('admin delete removes linked delivery events from any provider', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-10-08T00:00:00.000Z')
	const target = delivery(now, {
		deliveryId: 'delivery-linked-any-provider',
		messageId: 'message-linked-any-provider',
		rawMimeKey: 'email-raw:v1:system:email/message-linked-any-provider',
	})
	await storeThroughReceived({ db, target, now })
	sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, detail_json, created_at
			) VALUES (?, ?, 'received', 'test', '{}', ?)`,
		)
		.run('linked-test-event', target.messageId, now.toISOString())

	await deleteSystemEmailMessageById({
		db,
		blobs: { delete: async () => undefined } as unknown as R2Bucket,
		messageId: target.messageId,
	})

	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_delivery_events WHERE id = ?`)
			.get('linked-test-event'),
	).toBeUndefined()
	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_messages WHERE id = ?`)
			.get(target.messageId),
	).toBeUndefined()
})
