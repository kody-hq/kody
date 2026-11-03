import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { JobsStore } from '@kody-internal/shared/jobs/store.ts'
import type { UserMeterEnv } from './user-meter-client.ts'
import {
	advanceD1StorageReconciliationCursor,
	bootstrapOwnerD1StorageBytes,
	listUsersForD1StorageReconciliation,
	reconcileUserD1StorageBytes,
} from './service.ts'

/**
 * Corrective physical-storage reconciliation under UserMeter authority.
 * Recomputes a small keyset page of per-user storage bytes from D1 payload
 * tables and applies the result to UserMeter via a revision-guarded CAS
 * (never clobbers a live reservation).
 *
 * Result codes:
 * - `updated` — CAS applied (or cold init succeeded); UserMeter updated.
 * - `deferred` — CAS missed a concurrent reserve, or an init race was
 *   detected; the row is retried on the next full sweep wrap. A deferred row
 *   is **not** a failure.
 * - `failed` — unexpected error; retried on the next sweep wrap.
 *
 * Pages walk live owner ids (personal orgs and team orgs) ascending from the
 * platform-owned `d1_storage_reconcile_cursor` singleton, wrapping at the tail.
 * Row failures do not fail the lane; `env` is required (UserMeter is the
 * authority).
 *
 * Cold reserve and usage reads call {@link enqueueOwnerD1StorageReconcile}
 * for an immediate per-owner cold bootstrap (initialize only — never CAS a
 * live meter) so a cold meter is not stuck at 0 until the keyset sweep wraps.
 * Concurrent callers share one in-flight promise (lazy enqueue).
 */
export const d1StorageReconciliationBatchSize = 8

const inFlightOwnerReconciles = new Map<OwnerId, Promise<unknown>>()

/**
 * Lazy per-owner cold physical bootstrap. Dedupes in-flight work for the same
 * owner and returns the shared promise so reserve and usage reads share one
 * SUM. Uses {@link bootstrapOwnerD1StorageBytes} (initialize only) — never the
 * CAS path, so a concurrent reserve cannot be wiped by an absolute set.
 * Callers that detach without awaiting should pass `waitUntil`.
 *
 * By default failures propagate (fail closed for awaited reserve/seed). Pass
 * `soft: true` only for fire-and-forget backstop work that may log and drop
 * the error — never use soft on the reserve path.
 */
export function enqueueOwnerD1StorageReconcile(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	now?: Date
	jobs?: JobsStore
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * When true, log and swallow bootstrap failures. Default false so awaited
	 * callers fail closed instead of zero-initing past existing payload.
	 */
	soft?: boolean
}): Promise<unknown> {
	const existing = inFlightOwnerReconciles.get(input.userId)
	if (existing) {
		input.waitUntil?.(existing)
		return existing
	}

	const soft = input.soft === true
	const task = bootstrapOwnerD1StorageBytes({
		db: input.db,
		env: input.env,
		userId: input.userId,
		now: input.now,
		jobs: input.jobs,
	})
		.catch((error: unknown) => {
			if (soft) {
				console.warn('d1-storage-owner-reconcile-failed', input.userId, error)
				return
			}
			throw error
		})
		.finally(() => {
			if (inFlightOwnerReconciles.get(input.userId) === task) {
				inFlightOwnerReconciles.delete(input.userId)
			}
		})
	inFlightOwnerReconciles.set(input.userId, task)
	input.waitUntil?.(task)
	return task
}

/** Test helper: await fire-and-forget per-owner reconciles in this isolate. */
export async function flushOwnerD1StorageReconcilesForTests(): Promise<void> {
	await Promise.all(inFlightOwnerReconciles.values())
}

/** Test helper: drop in-flight dedupe so a later enqueue runs fresh. */
export function clearOwnerD1StorageReconcileDedupeForTests(): void {
	inFlightOwnerReconciles.clear()
}

export async function reconcileD1StorageBytes(input: {
	db: D1Database
	now?: Date
	batchSize?: number
	/** Required because UserMeter is the storage-usage authority. */
	env: UserMeterEnv
	/** Jobs-worker byte contribution (see calculateUserD1StorageBytes). */
	jobs?: JobsStore
}): Promise<{
	scanned: number
	updated: number
	failed: number
	deferred: number
}> {
	const now = input.now ?? new Date()
	const rows = await listUsersForD1StorageReconciliation({
		db: input.db,
		limit: input.batchSize ?? d1StorageReconciliationBatchSize,
	})
	let updated = 0
	let failed = 0
	let deferred = 0
	for (const row of rows) {
		try {
			const result = await reconcileUserD1StorageBytes({
				db: input.db,
				env: input.env,
				jobs: input.jobs,
				userId: row.userId,
				now,
			})
			if (result.updated) {
				updated += 1
			} else if (result.deferred) {
				deferred += 1
			}
		} catch (error) {
			failed += 1
			console.warn('d1-storage-reconciliation-row-failed', row.userId, error)
		}
	}
	const lastUserId = rows.at(-1)?.userId
	if (lastUserId != null) {
		await advanceD1StorageReconciliationCursor({
			db: input.db,
			lastUserId,
			now,
		}).catch(() => undefined)
	}
	return { scanned: rows.length, updated, failed, deferred }
}
