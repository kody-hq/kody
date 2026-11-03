import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type { InboundDelivery } from './inbound-delivery.ts'
import {
	claimSystemInboundSubscriptionEffect,
	listDueSystemInboundEffects,
} from './system-inbound-effect-store.ts'
import { claimSystemInboundDeliveryStorage } from './system-inbound-delivery-store.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return sqlite
}

function delivery(
	id: string,
	state: InboundDelivery['state'],
): InboundDelivery {
	return {
		deliveryId: id,
		messageId: `message-${id}`,
		threadId: `thread-${id}`,
		rawMimeKey: `email-raw:v1:system:email/message-${id}`,
		userId: ownerIdFromStored('system:email'),
		inboxId: `inbox-${id}`,
		recipient: 'support@example.com',
		envelopeFrom: 'sender@example.net',
		provider: 'cloudflare-email-routing',
		quotaDay: '2026-08-03',
		dedupeExpiresAt: '2026-08-05T00:00:00.000Z',
		fingerprint: `fingerprint-${id}`,
		state,
	}
}

test('NULL system lease timestamps remain due and reclaimable', async () => {
	using sqlite = createDatabase()
	const createdAt = '2026-08-01T00:00:00.000Z'
	const now = new Date('2026-08-03T00:00:00.000Z')
	const usage = {
		...delivery('usage-null-at', 'received'),
		usageEffectLease: 'usage-lease',
		subscriptionEffectState: 'complete' as const,
	}
	const subscription = {
		...delivery('subscription-null-at', 'received'),
		usageEffectRecordedAt: createdAt,
		subscriptionEffectState: 'processing' as const,
		subscriptionEffectLease: 'subscription-lease',
	}
	const storage = {
		...delivery('storage-null-at', 'storing'),
		storageLease: 'storage-lease',
	}
	const insertDedicated = sqlite.prepare(
		`INSERT INTO system_email_delivery_events (
			id, event_type, provider, detail_json, created_at,
			needs_effect_reconcile, state, fingerprint,
			usage_effect_recorded_at, usage_effect_lease, usage_effect_lease_at,
			subscription_effect_state, subscription_effect_lease,
			subscription_effect_lease_at, storage_lease, storage_lease_at,
			updated_at
		) VALUES (?, ?, 'cloudflare-email-routing', ?, ?, ?, ?, ?, ?, ?, NULL,
			?, ?, NULL, ?, NULL, ?)`,
	)
	for (const row of [
		{
			detail: usage,
			eventType: 'received',
			needsEffect: 1,
			usageRecordedAt: null,
			usageLease: usage.usageEffectLease,
			subscriptionState: usage.subscriptionEffectState,
			subscriptionLease: null,
			storageLease: null,
		},
		{
			detail: subscription,
			eventType: 'received',
			needsEffect: 1,
			usageRecordedAt: subscription.usageEffectRecordedAt,
			usageLease: null,
			subscriptionState: subscription.subscriptionEffectState,
			subscriptionLease: subscription.subscriptionEffectLease,
			storageLease: null,
		},
		{
			detail: storage,
			eventType: 'receive_started',
			needsEffect: 0,
			usageRecordedAt: null,
			usageLease: null,
			subscriptionState: null,
			subscriptionLease: null,
			storageLease: storage.storageLease,
		},
	]) {
		const bindings = [
			row.detail.deliveryId,
			row.eventType,
			JSON.stringify(row.detail),
			createdAt,
			row.needsEffect,
			row.detail.state,
			row.detail.fingerprint,
			row.usageRecordedAt,
			row.usageLease,
			row.subscriptionState,
			row.subscriptionLease,
			row.storageLease,
			createdAt,
		] as const
		insertDedicated.run(...bindings)
	}
	const db = createD1FromSqlite(sqlite)

	expect(await listDueSystemInboundEffects({ db, now, limit: 10 })).toEqual([
		{ id: subscription.deliveryId },
		{ id: usage.deliveryId },
	])
	expect(
		await claimSystemInboundSubscriptionEffect({
			db,
			deliveryId: subscription.deliveryId,
			finalizationToken: undefined,
			now,
		}),
	).toEqual(expect.any(String))
	expect(
		await claimSystemInboundDeliveryStorage({
			db,
			delivery: storage,
			expectedAttachmentCount: 0,
			now,
		}),
	).toMatchObject({ claimed: true })
})
