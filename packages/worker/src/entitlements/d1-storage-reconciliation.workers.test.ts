import {
	resetIsolateState,
	settleIsolateState,
} from '@kody-internal/shared/isolate-state-test-support.ts'
import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	calculateUserD1StorageBytes,
	listUsersForD1StorageReconciliation,
	reconcileUserD1StorageBytes,
	assertWithinStorageBytesEntitlement,
} from './service.ts'
import {
	enqueueOwnerD1StorageReconcile,
	reconcileD1StorageBytes,
} from './d1-storage-reconciliation.ts'
import { userMeterRpc } from './user-meter-client.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
/**
 * `cursorBefore` points the keyset cursor immediately below the user so the
 * next lane page starts there (test ids are unique 64-char strings; a 63-char
 * prefix sorts strictly between neighbours).
 */
async function seedUser(
	userId: string,
	input: { payloadBytes?: number; cursorBefore?: boolean } = {},
) {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id
		) VALUES (?, ?, 'test-password', ?)`,
	)
		.bind(
			`d1-reconcile-${crypto.randomUUID().slice(0, 8)}`,
			`${crypto.randomUUID()}@example.test`,
			userId,
		)
		.run()
	if (input.payloadBytes)
		await insertTrackedD1Payload(userId, input.payloadBytes)
	if (input.cursorBefore) await setReconcileCursorBefore(userId)
	return {
		userId,
		meter: userMeterRpc({ env, userId: ownerIdFromStored(userId) }),
		physicalBytes: () =>
			calculateUserD1StorageBytes({
				db: env.APP_DB,
				userId: ownerIdFromStored(userId),
			}),
	}
}

async function setReconcileCursorBefore(userId: string) {
	await env.APP_DB.prepare(
		`UPDATE d1_storage_reconcile_cursor
		SET position = ?, updated_at = ?
		WHERE singleton = 1`,
	)
		.bind(userId.slice(0, -1), new Date().toISOString())
		.run()
}

async function readReconcileCursor() {
	const row = await env.APP_DB.prepare(
		`SELECT position FROM d1_storage_reconcile_cursor
		WHERE singleton = 1`,
	).first<{ position: string }>()
	return row?.position ?? null
}

async function insertTrackedD1Payload(userId: string, size: number) {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS mcp_memories (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			category TEXT,
			subject TEXT,
			summary TEXT,
			details TEXT,
			tags_json TEXT,
			source_uris_json TEXT,
			dedupe_key TEXT
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT INTO mcp_memories (id, user_id, subject, summary, details)
		VALUES (?, ?, 'storage reconciliation', 'tracked payload', ?)`,
	)
		.bind(crypto.randomUUID(), userId, 'x'.repeat(size))
		.run()
}

function envWithMeter(meterStub: Record<string, unknown>) {
	return {
		USER_METER: {
			idFromName: env.USER_METER.idFromName.bind(env.USER_METER),
			get: () => meterStub,
		},
	} as unknown as typeof env
}

function reconcileLane(now: string, batchSize: number, laneEnv = env) {
	return reconcileD1StorageBytes({
		db: env.APP_DB,
		env: laneEnv,
		now: new Date(now),
		batchSize,
	})
}

function reconcileUser(userId: string, userEnv = env) {
	return reconcileUserD1StorageBytes({
		db: env.APP_DB,
		env: userEnv,
		userId: ownerIdFromStored(userId),
		now: new Date('2026-08-01T01:00:00.000Z'),
	})
}

test('D1 storage reconciliation is UserMeter-authoritative and advances the keyset cursor', async () => {
	const first = await seedUser('1'.repeat(64), {
		payloadBytes: 256,
		cursorBefore: true,
	})
	const second = await seedUser('1'.repeat(63) + '2')
	const expectedFirstBytes = await first.physicalBytes()
	expect(expectedFirstBytes).toBeGreaterThan(128)
	expect(await first.meter.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})

	// Reconcile first user into authoritative UserMeter state.
	await expect(reconcileLane('2026-07-31T01:00:00.000Z', 1)).resolves.toEqual({
		scanned: 1,
		updated: 1,
		failed: 0,
		deferred: 0,
	})
	// The keyset cursor advanced past the processed user.
	await expect(readReconcileCursor()).resolves.toBe(first.userId)
	// UserMeter is now authoritative with the physical value.
	expect(await first.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: expectedFirstBytes,
	})

	// Second user (no tracked payload): the next page continues from the
	// advanced cursor and the meter reconciles to zero.
	await expect(reconcileLane('2026-07-31T01:05:00.000Z', 1)).resolves.toEqual({
		scanned: 1,
		updated: 1,
		failed: 0,
		deferred: 0,
	})
	await expect(readReconcileCursor()).resolves.toBe(second.userId)
	expect(await second.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 0,
	})
})

async function seedOrg(orgId: string, input: { deleted?: boolean } = {}) {
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, deleted_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			orgId,
			`reconcile-${crypto.randomUUID().slice(0, 8)}`,
			input.deleted ? '2026-07-01T00:00:00.000Z' : null,
			'2026-06-01T00:00:00.000Z',
			'2026-06-01T00:00:00.000Z',
		)
		.run()
}

test('reconciliation sweeps team orgs, which have no users row, and skips deleted orgs', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const teamOrgId = 'b'.repeat(64)
	await seedOrg('b'.repeat(63) + 'a', { deleted: true })
	await seedOrg(teamOrgId)
	await insertTrackedD1Payload(teamOrgId, 256)
	await setReconcileCursorBefore(teamOrgId)
	const teamMeter = userMeterRpc({ env, userId: ownerIdFromStored(teamOrgId) })
	const expectedBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId: ownerIdFromStored(teamOrgId),
	})
	expect(expectedBytes).toBeGreaterThan(128)

	await expect(reconcileLane('2026-07-31T02:00:00.000Z', 1)).resolves.toEqual({
		scanned: 1,
		updated: 1,
		failed: 0,
		deferred: 0,
	})
	await expect(readReconcileCursor()).resolves.toBe(teamOrgId)
	expect(await teamMeter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: expectedBytes,
	})
})

test('reconciliation visits a personal org once even though it has users and orgs rows', async () => {
	const personal = await seedUser('c'.repeat(64), { cursorBefore: true })
	await seedOrg(personal.userId)

	const page = await listUsersForD1StorageReconciliation({
		db: env.APP_DB,
		limit: 2,
	})
	expect(page[0]).toEqual({ userId: personal.userId })
	expect(page[1]?.userId).not.toBe(personal.userId)
})

test('reconciliation sets UserMeter to the physical-payload absolute, via the lane and directly', async () => {
	// Pre-set UserMeter to a large stale value that physical recompute should replace.
	const lane = await seedUser('5'.repeat(64), {
		payloadBytes: 256,
		cursorBefore: true,
	})
	await lane.meter.setStorageBytes({
		bytes: 500_000,
		updatedAt: '2026-07-31T00:00:00.000Z',
	})
	const laneBytes = await lane.physicalBytes()
	await expect(
		reconcileLane('2026-07-31T01:00:00.000Z', 8),
	).resolves.toMatchObject({ failed: 0 })
	expect(await lane.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: laneBytes,
	})
	expect(laneBytes).not.toBe(500_000)

	const direct = await seedUser('8'.repeat(64), { payloadBytes: 256 })
	await direct.meter.setStorageBytes({
		bytes: 500_000,
		updatedAt: '2026-08-01T00:00:00.000Z',
	})
	const directBytes = await direct.physicalBytes()
	expect(directBytes).toBeGreaterThan(0)
	expect(directBytes).toBeLessThan(500_000)
	expect(await reconcileUser(direct.userId)).toEqual({
		bytes: directBytes,
		updated: true,
		deferred: false,
	})
	expect(await direct.meter.readStorageBytes()).toMatchObject({
		bytes: directBytes,
	})
})

test('reconciliation row failure is isolated: UserMeter set failure counts as failed and the cursor still advances', async () => {
	const failing = await seedUser('6'.repeat(64), { cursorBefore: true })
	consoleWarn.mockImplementation(() => {})
	const failingMeterEnv = envWithMeter({
		readStorageBytes: async () => ({ outcome: 'needs_bootstrap' as const }),
		initializeStorageBytes: async () => {
			throw new Error('UserMeter reconcile failed')
		},
	})

	await expect(
		reconcileLane('2026-07-31T01:15:00.000Z', 1, failingMeterEnv),
	).resolves.toEqual({ scanned: 1, updated: 0, failed: 1, deferred: 0 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'd1-storage-reconciliation-row-failed',
		failing.userId,
		expect.any(Error),
	)
	// The keyset cursor advances past failed rows; they retry on the next wrap.
	await expect(readReconcileCursor()).resolves.toBe(failing.userId)
})

test('reconcile defers and preserves reserve when CAS misses a concurrent reservation between revision capture and CAS', async () => {
	const { userId, meter, physicalBytes } = await seedUser('7'.repeat(64), {
		payloadBytes: 256,
	})
	// Seed DO at revision=1 with 100 bytes.
	await meter.initializeStorageBytes({
		bytes: 100,
		updatedAt: '2026-08-01T00:00:00.000Z',
	})
	const expectedBytes = await physicalBytes()
	expect(expectedBytes).toBeGreaterThan(0)

	// readStorageBytes forwards to the real DO; reconcileStorageBytes first
	// does a concurrent reserve (bumping revision 1→2), then forwards the CAS
	// with the stale expectedRevision so it naturally misses.
	const reservations: Array<unknown> = []
	const concurrentMeterEnv = envWithMeter({
		readStorageBytes: () => meter.readStorageBytes(),
		async reconcileStorageBytes(input: {
			bytes: number
			expectedRevision: number
			updatedAt: string
		}) {
			reservations.push(
				await meter.reserveStorageBytes({
					requested: 50,
					limit: 1_000_000,
					updatedAt: '2026-08-01T00:00:02.000Z',
				}),
			)
			return meter.reconcileStorageBytes(input)
		},
	})

	expect(await reconcileUser(userId, concurrentMeterEnv)).toEqual({
		bytes: expectedBytes,
		updated: false,
		deferred: true,
	})
	expect(reservations).toEqual([
		expect.objectContaining({ reserved: true, revision: 2, bytes: 150 }),
	])
	// Real DO still has 150 bytes (initial 100 + reserve 50).
	expect(await meter.readStorageBytes()).toMatchObject({ bytes: 150 })
})

test('lazy per-owner enqueue seeds a cold meter from physical bytes and dedupes in-flight work', async () => {
	resetIsolateState()
	const owner = await seedUser('a'.repeat(63) + 'e', { payloadBytes: 256 })
	const expectedBytes = await owner.physicalBytes()
	expect(expectedBytes).toBeGreaterThan(128)
	expect(await owner.meter.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})

	const first = enqueueOwnerD1StorageReconcile({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(owner.userId),
		now: new Date('2026-08-01T03:00:00.000Z'),
	})
	const second = enqueueOwnerD1StorageReconcile({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(owner.userId),
		now: new Date('2026-08-01T03:00:00.000Z'),
	})
	await Promise.all([first, second])
	expect(await owner.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: expectedBytes,
	})
})

test('cold storage reserve awaits the lazy per-owner reconcile before adding the reservation', async () => {
	resetIsolateState()
	const owner = await seedUser('a'.repeat(63) + 'f', { payloadBytes: 256 })
	const expectedBytes = await owner.physicalBytes()
	expect(expectedBytes).toBeGreaterThan(128)

	await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(owner.userId),
		email: `${owner.userId}@example.test`,
		requested: 40,
	})
	await settleIsolateState()
	expect(await owner.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: expectedBytes + 40,
	})
})

test('reconcile defers without overwriting when cold init race: another caller created meter state first', async () => {
	const { userId, physicalBytes } = await seedUser('9'.repeat(64), {
		payloadBytes: 256,
	})
	const expectedBytes = await physicalBytes()
	expect(expectedBytes).toBeGreaterThan(0)

	// The meter reports needs_bootstrap on read, but another concurrent
	// reconcile/bootstrap caller already created the singleton.
	let initCallCount = 0
	const raceEnv = envWithMeter({
		readStorageBytes: async () => ({ outcome: 'needs_bootstrap' as const }),
		async initializeStorageBytes() {
			initCallCount++
			return {
				outcome: 'ready' as const,
				bytes: 999,
				revision: 3,
				mirrorUpdatedAt: 'r/00000000000000000003',
				created: false,
			}
		},
	})

	expect(await reconcileUser(userId, raceEnv)).toEqual({
		bytes: expectedBytes,
		updated: false,
		deferred: true,
	})
	expect(initCallCount).toBe(1)
})
