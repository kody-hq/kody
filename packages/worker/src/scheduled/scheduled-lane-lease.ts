import type { ScheduledLaneName } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { Clock, Effect, Option } from 'effect'
import { D1, retryTransientD1, sql } from '#worker/effect/d1.ts'
import { scopedClaim } from '#worker/effect/claim.ts'
import { runD1PromiseLazy as runD1Promise } from '#worker/effect/slice-edge.ts'

/**
 * Lanes that must not overlap. A tick whose predecessor still holds the lease
 * skips; the lease outlives the lane budget only briefly so a killed consumer
 * frees the lane before the next cadence tick.
 */
export const scheduledLaneLeaseMs: Partial<Record<ScheduledLaneName, number>> =
	{
		// Lane budget (60s) plus one source deadline (45s), with headroom.
		reconcile_artifacts_pushes: 3 * 60_000,
		// One tick at a time: 40s budget plus one slow scan or mail page.
		package_app_host_migration_reminder: 4 * 60_000,
	}

export async function acquireScheduledLaneLease(
	db: D1Database,
	input: {
		lane: ScheduledLaneName
		holder: string
		leaseMs: number
		now: Date
	},
): Promise<boolean> {
	const nowIso = input.now.toISOString()
	const expiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString()
	const result = await runD1WithRetry(() =>
		db
			.prepare(
				`INSERT INTO scheduled_lane_leases (lane, holder, expires_at)
				VALUES (?, ?, ?)
				ON CONFLICT(lane) DO UPDATE SET
					holder = excluded.holder,
					expires_at = excluded.expires_at
				WHERE scheduled_lane_leases.expires_at <= ?`,
			)
			.bind(input.lane, input.holder, expiresAt, nowIso)
			.run(),
	)
	return (result.meta.changes ?? 0) > 0
}

/**
 * Extend a lease this holder still owns. False means another holder took the
 * lane after this one expired, so the caller is stale and must stop writing.
 */
export async function renewScheduledLaneLease(
	db: D1Database,
	input: {
		lane: ScheduledLaneName
		holder: string
		leaseMs: number
		now: Date
	},
): Promise<boolean> {
	const expiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString()
	const result = await runD1WithRetry(() =>
		db
			.prepare(
				`UPDATE scheduled_lane_leases SET expires_at = ?
				WHERE lane = ? AND holder = ?`,
			)
			.bind(expiresAt, input.lane, input.holder)
			.run(),
	)
	return (result.meta.changes ?? 0) > 0
}

export async function releaseScheduledLaneLease(
	db: D1Database,
	input: { lane: ScheduledLaneName; holder: string },
) {
	await runD1WithRetry(() =>
		db
			.prepare(
				`DELETE FROM scheduled_lane_leases WHERE lane = ? AND holder = ?`,
			)
			.bind(input.lane, input.holder)
			.run(),
	)
}

/** The lease clock: the caller's `now`, else the Effect `Clock`. */
const leaseExpiry = Effect.fnUntraced(function* (
	leaseMs: number,
	now: Date | undefined,
) {
	const nowMs = now ? now.getTime() : yield* Clock.currentTimeMillis
	return {
		nowIso: new Date(nowMs).toISOString(),
		expiresAt: new Date(nowMs + leaseMs).toISOString(),
	}
})

export const acquireScheduledLaneLeaseEffect = Effect.fn(
	'ScheduledLaneLease.acquire',
)(function* (input: {
	lane: ScheduledLaneName
	holder: string
	leaseMs: number
	now?: Date
}) {
	const d1 = yield* D1
	const { nowIso, expiresAt } = yield* leaseExpiry(input.leaseMs, input.now)
	const result = yield* retryTransientD1(
		d1.run(
			'scheduled_lane_lease.acquire',
			sql(
				`INSERT INTO scheduled_lane_leases (lane, holder, expires_at)
				VALUES (?, ?, ?)
				ON CONFLICT(lane) DO UPDATE SET
					holder = excluded.holder,
					expires_at = excluded.expires_at
				WHERE scheduled_lane_leases.expires_at <= ?`,
				input.lane,
				input.holder,
				expiresAt,
				nowIso,
			),
		),
	)
	return result.changes > 0
})

export const renewScheduledLaneLeaseEffect = Effect.fn(
	'ScheduledLaneLease.renew',
)(function* (input: {
	lane: ScheduledLaneName
	holder: string
	leaseMs: number
	now?: Date
}) {
	const d1 = yield* D1
	const { expiresAt } = yield* leaseExpiry(input.leaseMs, input.now)
	const result = yield* retryTransientD1(
		d1.run(
			'scheduled_lane_lease.renew',
			sql(
				`UPDATE scheduled_lane_leases SET expires_at = ?
				WHERE lane = ? AND holder = ?`,
				expiresAt,
				input.lane,
				input.holder,
			),
		),
	)
	return result.changes > 0
})

export const releaseScheduledLaneLeaseEffect = Effect.fn(
	'ScheduledLaneLease.release',
)(function* (input: { lane: ScheduledLaneName; holder: string }) {
	const d1 = yield* D1
	yield* retryTransientD1(
		d1.run(
			'scheduled_lane_lease.release',
			sql(
				`DELETE FROM scheduled_lane_leases WHERE lane = ? AND holder = ?`,
				input.lane,
				input.holder,
			),
		),
	)
})

/**
 * The lane lease as a scoped resource: `None` when another holder has the
 * lane, else the holder id, released when the scope closes on success,
 * failure or interruption. A failed release is logged; the lease then
 * expires on its own.
 */
export const scopedScheduledLaneLease = (input: {
	lane: ScheduledLaneName
	leaseMs: number
}) =>
	scopedClaim(
		Effect.gen(function* () {
			const holder = crypto.randomUUID()
			const acquired = yield* acquireScheduledLaneLeaseEffect({
				lane: input.lane,
				holder,
				leaseMs: input.leaseMs,
			})
			return acquired ? Option.some(holder) : Option.none()
		}),
		(holder) =>
			releaseScheduledLaneLeaseEffect({ lane: input.lane, holder }).pipe(
				Effect.catch((error) =>
					Effect.logWarning('scheduled_lane_lease_release_failed', {
						lane: input.lane,
						error: error.message,
					}),
				),
			),
	)

/** Promise edges for callers and tests that hold a bare D1 binding. */
export const acquireScheduledLaneLeaseViaEffect = (
	db: D1Database,
	input: Parameters<typeof acquireScheduledLaneLease>[1],
) =>
	runD1Promise(db, (d1) =>
		acquireScheduledLaneLeaseEffect(input).pipe(Effect.provideService(D1, d1)),
	)

export const releaseScheduledLaneLeaseViaEffect = (
	db: D1Database,
	input: Parameters<typeof releaseScheduledLaneLease>[1],
) =>
	runD1Promise(db, (d1) =>
		releaseScheduledLaneLeaseEffect(input).pipe(Effect.provideService(D1, d1)),
	)
