import type { ScheduledLaneName } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { reconcileLaneLeaseMs } from '#worker/jobs/reconcile-artifacts-pushes.ts'

/**
 * Lanes that must not overlap. A tick whose predecessor still holds the lease
 * skips; the lease outlives the lane budget only briefly so a killed consumer
 * frees the lane before the next cadence tick.
 */
export const scheduledLaneLeaseMs: Partial<Record<ScheduledLaneName, number>> =
	{
		reconcile_artifacts_pushes: reconcileLaneLeaseMs,
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
