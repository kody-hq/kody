import {
	acquireScheduledLaneLease,
	releaseScheduledLaneLease,
	renewScheduledLaneLease,
} from '#worker/scheduled/scheduled-lane-lease.ts'
import type { DrBackupS3Client } from '#worker/dr/backup-s3.ts'

const lane = 'dr_d1_paced_backup'

/**
 * Every write extends the lease, so it only has to outlive the gap between
 * writes. A tick killed mid-run (45s budget, 180s on full-base nights) frees
 * the lane before the next 5 minute cron tick.
 */
export const d1PacedBackupLeaseMs = 2 * 60_000

export class D1PacedBackupLeaseLostError extends Error {
	constructor() {
		super(
			'paced D1 backup tick lost its lease to a newer tick and stopped before writing',
		)
		this.name = 'D1PacedBackupLeaseLostError'
	}
}

export type D1PacedBackupLease = {
	/** Extends the lease, or throws once another tick owns the lane. */
	assertHeld: () => Promise<void>
	release: () => Promise<void>
}

/**
 * Single-flight for the paced backup lane. Two ticks that both load the same
 * staging progress interleave part writes and leave a table index with
 * repeated rowids, which the next delta night turns into delete lines for
 * live rows. Returns null while another tick holds the lane.
 */
export async function claimD1PacedBackupLease(
	db: D1Database,
): Promise<D1PacedBackupLease | null> {
	const holder = crypto.randomUUID()
	const acquired = await acquireScheduledLaneLease(db, {
		lane,
		holder,
		leaseMs: d1PacedBackupLeaseMs,
		now: new Date(),
	})
	if (!acquired) return null
	return {
		async assertHeld() {
			const renewed = await renewScheduledLaneLease(db, {
				lane,
				holder,
				leaseMs: d1PacedBackupLeaseMs,
				now: new Date(),
			})
			if (!renewed) throw new D1PacedBackupLeaseLostError()
		},
		release: () => releaseScheduledLaneLease(db, { lane, holder }),
	}
}

/** Every put checks the lease first, so a stale tick cannot write. */
export function guardDrBackupS3Writes(
	s3: DrBackupS3Client,
	lease: D1PacedBackupLease,
): DrBackupS3Client {
	return {
		head: (key) => s3.head(key),
		getText: (key) => s3.getText(key),
		getBytes: (key) => s3.getBytes(key),
		async put(key, body, options) {
			await lease.assertHeld()
			return s3.put(key, body, options)
		},
	}
}
