import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	dailyEntitlementResources,
	type DailyEntitlementResource,
} from '#universal/plans.ts'
import { calculateUserD1StorageBytes } from '#worker/entitlements/service.ts'
import type { JobsStore } from '@kody-internal/shared/jobs/store.ts'
import {
	parseOwnerId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

type DailyResourceRead = {
	resource: DailyEntitlementResource
	meterCount: number | null
	needsBootstrap: boolean
}

type StorageParity = {
	d1Bytes: number
	meterBytes: number | null
	needsBootstrap: boolean
	delta: number | null
	parity: boolean
}

type DeletionParity = {
	d1DeletingAt: string | null
	meterDeletingAt: string | null
	deletingAtParity: boolean
	/** Active DO write-lease count (meter-only; D1 lease mirror is retired). */
	activeLeaseCount: number
}

export type AdminUserMeterParityReport = {
	generatedAt: string
	stableUserId: OwnerId
	/**
	 * Daily counters are UserMeter-only. There is no D1
	 * `entitlement_daily_counters` mirror, so this section reports meter counts
	 * without any D1 comparison.
	 */
	daily: {
		day: string
		resources: Array<DailyResourceRead>
	}
	storage: StorageParity
	deletion: DeletionParity
}

function countDeltaParity(input: {
	d1Value: number
	meterValue: number | null
	needsBootstrap: boolean
}): { delta: number | null; parity: boolean } {
	if (input.needsBootstrap || input.meterValue == null) {
		return { delta: null, parity: false }
	}
	const delta = input.d1Value - input.meterValue
	return { delta, parity: delta === 0 }
}

async function ownerExists(db: D1Database, stableUserId: OwnerId) {
	const userRow = await db
		.prepare(
			`SELECT 1 AS present FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ present: number }>()
	if (userRow != null) return true
	const orgRow = await db
		.prepare(
			`SELECT 1 AS present FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ present: number }>()
	return orgRow != null
}

async function readDailyMeterCounts(input: {
	env: UserMeterEnv
	stableUserId: OwnerId
	day: string
	generatedAt: string
}): Promise<AdminUserMeterParityReport['daily']> {
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const resources: Array<DailyResourceRead> = []
	for (const resource of dailyEntitlementResources) {
		const meterRead = await meter.read({
			resource,
			day: input.day,
			now: input.generatedAt,
		})
		const needsBootstrap = meterRead.outcome === 'needs_bootstrap'
		resources.push({
			resource,
			meterCount: needsBootstrap ? null : meterRead.count,
			needsBootstrap,
		})
	}
	return { day: input.day, resources }
}

async function readStorageParity(input: {
	db: D1Database
	env: UserMeterEnv
	jobs?: JobsStore
	stableUserId: OwnerId
}): Promise<StorageParity> {
	// Physical recompute from D1 payload tables — the same source the
	// reconcile lane applies to UserMeter. The retired users.d1_storage_bytes
	// mirror is never read.
	const d1Bytes = Math.max(
		0,
		await calculateUserD1StorageBytes({
			db: input.db,
			jobs: input.jobs,
			userId: input.stableUserId,
		}),
	)
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const meterRead = await meter.readStorageBytes()
	const needsBootstrap = meterRead.outcome === 'needs_bootstrap'
	const meterBytes = needsBootstrap ? null : meterRead.bytes
	const { delta, parity } = countDeltaParity({
		d1Value: d1Bytes,
		meterValue: meterBytes,
		needsBootstrap,
	})
	return {
		d1Bytes,
		meterBytes,
		needsBootstrap,
		delta,
		parity,
	}
}

async function readDeletionParity(input: {
	db: D1Database
	env: UserMeterEnv
	stableUserId: OwnerId
}): Promise<DeletionParity> {
	const userDeletingRow = await input.db
		.prepare(
			`SELECT deleting_at FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.stableUserId)
		.first<{ deleting_at: string | null }>()
	let d1DeletingAt = userDeletingRow?.deleting_at ?? null
	if (userDeletingRow == null) {
		const orgDeletingRow = await input.db
			.prepare(
				`SELECT deleting_at FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(input.stableUserId)
			.first<{ deleting_at: string | null }>()
		d1DeletingAt = orgDeletingRow?.deleting_at ?? null
	}
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const meterDeletion = await meter.readDeletionState()
	const deletingAtParity = d1DeletingAt === meterDeletion.deletingAt
	const leaseCount = await meter.countActiveWriteLeases()
	return {
		d1DeletingAt,
		meterDeletingAt: meterDeletion.deletingAt,
		deletingAtParity,
		activeLeaseCount: leaseCount.count,
	}
}

/**
 * Read-only UserMeter verification report for one owner id (person or team
 * org). Storage compares a physical D1 payload recompute with the meter;
 * deletion compares the permanent D1 tombstone (`users.deleting_at`, else
 * `orgs.deleting_at`) with the meter fence. Never bootstraps or writes parity
 * state. Opening a cold UserMeter stub may still run Durable Object constructor
 * schema maintenance and opportunistic stale daily-counter pruning; cold meter
 * rows surface as `needsBootstrap`.
 */
export async function loadAdminUserMeterParityReport(input: {
	db: D1Database
	env: UserMeterEnv
	/** Jobs-worker byte contribution (see calculateUserD1StorageBytes). */
	jobs?: JobsStore
	stableUserId: string
	now?: Date
}): Promise<AdminUserMeterParityReport | null> {
	const stableUserId = parseOwnerId(input.stableUserId)
	if (!stableUserId) return null
	if (!(await ownerExists(input.db, stableUserId))) return null

	const now = input.now ?? new Date()
	const generatedAt = now.toISOString()
	const day = utcDayKey(now)

	const [daily, storage, deletion] = await Promise.all([
		readDailyMeterCounts({
			env: input.env,
			stableUserId,
			day,
			generatedAt,
		}),
		readStorageParity({
			db: input.db,
			env: input.env,
			jobs: input.jobs,
			stableUserId,
		}),
		readDeletionParity({
			db: input.db,
			env: input.env,
			stableUserId,
		}),
	])

	return {
		generatedAt,
		stableUserId,
		daily,
		storage,
		deletion,
	}
}
