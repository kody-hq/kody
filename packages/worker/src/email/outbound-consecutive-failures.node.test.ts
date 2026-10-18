import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	applyOutboundConsecutiveFailureTracking,
	clearOutboundDeliveryPause,
	loadOutboundDeliveryPause,
	outboundConsecutiveFailurePauseThreshold,
} from './outbound-consecutive-failures.ts'

async function createOrgDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await db
		.prepare(
			`CREATE TABLE orgs (
				id TEXT PRIMARY KEY NOT NULL,
				email_outbound_consecutive_failures INTEGER NOT NULL DEFAULT 0,
				email_outbound_delivery_paused_at TEXT,
				updated_at TEXT,
				deleted_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE email_outbound_failure_tracking (
				provider_event_id TEXT PRIMARY KEY NOT NULL,
				user_id TEXT NOT NULL,
				delivery_status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				applied_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, email_outbound_consecutive_failures, updated_at)
			 VALUES (?, 0, ?)`,
		)
		.bind('org_user_1', '2026-10-17T00:00:00.000Z')
		.run()
	return db
}

test('pauses after N consecutive terminal failures and clears on deliver or resume', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = await createOrgDb()
	const ownerId = ownerIdFromStored('org_user_1')

	for (let i = 1; i < outboundConsecutiveFailurePauseThreshold; i++) {
		const result = await applyOutboundConsecutiveFailureTracking({
			db,
			ownerId,
			deliveryStatus: 'failed',
			providerEventId: `event-fail-${i}`,
		})
		expect(result).toEqual({ paused: false, consecutiveFailures: i })
		expect(await loadOutboundDeliveryPause({ db, ownerId })).toMatchObject({
			pausedAt: null,
			consecutiveFailures: i,
		})
	}

	const paused = await applyOutboundConsecutiveFailureTracking({
		db,
		ownerId,
		deliveryStatus: 'failed',
		providerEventId: 'event-fail-threshold',
		now: new Date('2026-10-17T12:00:00.000Z'),
	})
	expect(paused.paused).toBe(true)
	expect(paused.consecutiveFailures).toBe(
		outboundConsecutiveFailurePauseThreshold,
	)
	expect(await loadOutboundDeliveryPause({ db, ownerId })).toMatchObject({
		pausedAt: '2026-10-17T12:00:00.000Z',
		consecutiveFailures: outboundConsecutiveFailurePauseThreshold,
	})

	await applyOutboundConsecutiveFailureTracking({
		db,
		ownerId,
		deliveryStatus: 'delivered',
		providerEventId: 'event-delivered-1',
	})
	expect(await loadOutboundDeliveryPause({ db, ownerId })).toMatchObject({
		pausedAt: '2026-10-17T12:00:00.000Z',
		consecutiveFailures: 0,
	})

	expect(
		await clearOutboundDeliveryPause({
			db,
			ownerId,
			now: new Date('2026-10-17T13:00:00.000Z'),
		}),
	).toBe(true)
	expect(await loadOutboundDeliveryPause({ db, ownerId })).toMatchObject({
		pausedAt: null,
		consecutiveFailures: 0,
	})
	expect(consoleWarn).toHaveBeenCalledWith('email-outbound-delivery-paused', {
		consecutiveFailures: outboundConsecutiveFailurePauseThreshold,
		deliveryStatus: 'failed',
	})
})

test('duplicate provider event ids do not inflate the consecutive-failure counter', async () => {
	const db = await createOrgDb()
	const ownerId = ownerIdFromStored('org_user_1')

	expect(
		await applyOutboundConsecutiveFailureTracking({
			db,
			ownerId,
			deliveryStatus: 'bounced',
			providerEventId: 'event-same',
		}),
	).toEqual({ paused: false, consecutiveFailures: 1 })
	expect(
		await applyOutboundConsecutiveFailureTracking({
			db,
			ownerId,
			deliveryStatus: 'bounced',
			providerEventId: 'event-same',
		}),
	).toEqual({ paused: false, consecutiveFailures: 1 })
	expect(await loadOutboundDeliveryPause({ db, ownerId })).toMatchObject({
		consecutiveFailures: 1,
	})
})

test('a pending failure count is applied on retry after a mid-flight crash', async () => {
	const db = await createOrgDb()
	const ownerId = ownerIdFromStored('org_user_1')

	// Simulate: provider event was recorded and a pending tracking row was
	// written, then processing crashed before the counter update + applied mark.
	await db
		.prepare(
			`INSERT INTO email_outbound_failure_tracking (
				provider_event_id, user_id, delivery_status, created_at, applied_at
			) VALUES (?, ?, ?, ?, NULL)`,
		)
		.bind('event-pending', ownerId, 'failed', '2026-10-17T12:00:00.000Z')
		.run()

	expect(
		await applyOutboundConsecutiveFailureTracking({
			db,
			ownerId,
			deliveryStatus: 'failed',
			providerEventId: 'event-pending',
		}),
	).toEqual({ paused: false, consecutiveFailures: 1 })

	const tracking = await db
		.prepare(
			`SELECT applied_at AS appliedAt
			 FROM email_outbound_failure_tracking
			 WHERE provider_event_id = ?`,
		)
		.bind('event-pending')
		.first<{ appliedAt: string | null }>()
	expect(tracking?.appliedAt).toEqual(expect.any(String))

	// A later duplicate queue delivery must not count again.
	expect(
		await applyOutboundConsecutiveFailureTracking({
			db,
			ownerId,
			deliveryStatus: 'failed',
			providerEventId: 'event-pending',
		}),
	).toEqual({ paused: false, consecutiveFailures: 1 })
})

test('applied retry still pauses when the count already hit the threshold', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = await createOrgDb()
	const ownerId = ownerIdFromStored('org_user_1')

	// Crash after increment+applied but before pause: count is at threshold,
	// applied_at is set, paused_at is still null.
	await db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_consecutive_failures = ?`,
		)
		.bind(outboundConsecutiveFailurePauseThreshold)
		.run()
	await db
		.prepare(
			`INSERT INTO email_outbound_failure_tracking (
				provider_event_id, user_id, delivery_status, created_at, applied_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			'event-threshold',
			ownerId,
			'failed',
			'2026-10-17T12:00:00.000Z',
			'2026-10-17T12:00:01.000Z',
		)
		.run()

	const result = await applyOutboundConsecutiveFailureTracking({
		db,
		ownerId,
		deliveryStatus: 'failed',
		providerEventId: 'event-threshold',
		now: new Date('2026-10-17T12:00:02.000Z'),
	})
	expect(result).toEqual({
		paused: true,
		consecutiveFailures: outboundConsecutiveFailurePauseThreshold,
	})
	expect(await loadOutboundDeliveryPause({ db, ownerId })).toMatchObject({
		pausedAt: '2026-10-17T12:00:02.000Z',
		consecutiveFailures: outboundConsecutiveFailurePauseThreshold,
	})
	expect(consoleWarn).toHaveBeenCalledWith('email-outbound-delivery-paused', {
		consecutiveFailures: outboundConsecutiveFailurePauseThreshold,
		deliveryStatus: 'failed',
	})
})
