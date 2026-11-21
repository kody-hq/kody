import { Effect } from 'effect'
import { pruneRetentionEffect } from '#app/retention.ts'
import { pruneUnverifiedAccountsEffect } from '#worker/account/unverified-account-purge.ts'
import { pruneExpiredGuestAccountsEffect } from '#worker/guest/guest-account-purge.ts'
import { pruneSoftDeletedEffect } from '#worker/orgs/purge.ts'
import { runSlicePromise } from '#worker/effect/slice.ts'

export const retentionLanes = [
	'retention',
	'unverified_account_purge',
	'soft_delete_purge',
] as const

export type RetentionLane = (typeof retentionLanes)[number]

export function isRetentionLane(lane: string): lane is RetentionLane {
	return (retentionLanes as ReadonlyArray<string>).includes(lane)
}

/** The lanes the hourly retention tick registers, as one Effect. */
export const runRetentionLaneEffect = Effect.fn('RetentionLanes.run')(
	function* (lane: RetentionLane, scheduledAt: Date) {
		yield* Effect.annotateCurrentSpan('scheduled.lane', lane)
		yield* Effect.logDebug('retention lane started', { lane })
		switch (lane) {
			case 'retention':
				return yield* pruneRetentionEffect({ now: scheduledAt })
			case 'unverified_account_purge': {
				const unverified = yield* pruneUnverifiedAccountsEffect({
					now: scheduledAt,
				})
				const guests = yield* pruneExpiredGuestAccountsEffect({
					now: scheduledAt,
				})
				return { ...unverified, guests }
			}
			case 'soft_delete_purge':
				return yield* pruneSoftDeletedEffect({ now: scheduledAt })
		}
	},
)

type LaneFailure = Effect.Error<ReturnType<typeof runRetentionLaneEffect>>

/**
 * Every typed failure a lane can end with, mapped to what the scheduled-lane
 * failure isolation expects. A D1 failure rethrows the driver error so lock
 * contention is still classified; everything else is already an `Error`. A
 * new failure tag without a case here fails to compile.
 */
function toLaneFailure(error: LaneFailure): unknown {
	switch (error._tag) {
		case 'DatabaseError':
			return error.reason === 'query' ? error.cause : error
		case 'OutboundCallError':
			return error.reason === 'failed' ? error.cause : error
		default: {
			const unmapped: never = error
			return unmapped
		}
	}
}

/** The Worker `scheduled` boundary for the retention lanes. */
export function runRetentionLane(input: {
	env: Env
	lane: RetentionLane
	scheduledAt: Date
}): Promise<unknown> {
	return runSlicePromise(
		input.env,
		runRetentionLaneEffect(input.lane, input.scheduledAt).pipe(
			Effect.mapError(toLaneFailure),
		),
	)
}
