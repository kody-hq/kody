import * as Sentry from '@sentry/cloudflare'
import { pruneRetention } from '#app/retention.ts'
import { pruneUnverifiedAccounts } from '#worker/account/unverified-account-purge.ts'
import { pruneExpiredGuestAccounts } from '#worker/guest/guest-account-purge.ts'
import { pruneSoftDeleted } from '#worker/orgs/purge.ts'
import { type Clock, systemClock } from './clock.ts'
import {
	assertNever,
	reportableCause,
	type RetentionFailure,
	toRetentionFailure,
} from './failures.ts'
import { traced } from './telemetry.ts'

/** Lanes the hourly retention tick dispatches (`shouldRunRetentionCron`). */
export const retentionTickLanes = [
	'retention',
	'unverified_account_purge',
	'soft_delete_purge',
] as const

export type RetentionTickLane = (typeof retentionTickLanes)[number]

export function isRetentionTickLane(lane: string): lane is RetentionTickLane {
	return (retentionTickLanes as ReadonlyArray<string>).includes(lane)
}

export type RetentionTickResult =
	| { ok: true; lane: RetentionTickLane; value: unknown }
	| { ok: false; lane: RetentionTickLane; failure: RetentionFailure }

async function dispatch(input: {
	env: Env
	lane: RetentionTickLane
	scheduledAt: Date
	clock: Clock
	signal?: AbortSignal
}): Promise<unknown> {
	const { env, clock, signal } = input
	const now = input.scheduledAt
	switch (input.lane) {
		case 'retention':
			return pruneRetention({ env, now, clock, signal })
		case 'unverified_account_purge': {
			const unverified = await pruneUnverifiedAccounts({
				env,
				now,
				clock,
				signal,
			})
			const guests = await pruneExpiredGuestAccounts({
				env,
				now,
				clock,
				signal,
			})
			return { ...unverified, guests }
		}
		case 'soft_delete_purge':
			return pruneSoftDeleted({ env, now, clock, signal })
		default:
			return assertNever(input.lane)
	}
}

/** Runs one retention-tick lane and returns its typed failure, never throws. */
export async function runRetentionTickLane(input: {
	env: Env
	lane: RetentionTickLane
	scheduledAt: Date
	clock?: Clock
	signal?: AbortSignal
}): Promise<RetentionTickResult> {
	const clock = input.clock ?? systemClock
	try {
		const value = await traced(
			`retention.tick.${input.lane}`,
			{ 'scheduled.lane': input.lane },
			() => dispatch({ ...input, clock }),
			clock,
		)
		return { ok: true, lane: input.lane, value }
	} catch (error) {
		return {
			ok: false,
			lane: input.lane,
			failure: toRetentionFailure(`retention.tick.${input.lane}`, error),
		}
	}
}

/**
 * Maps a lane failure to the scheduled-lane outcome. Exhaustive: adding a
 * RetentionFailure variant without a case here is a compile error. D1 lock
 * contention is retried by the queue; everything else is logged and sent to
 * Sentry with the original cause.
 */
export function scheduledOutcomeForRetentionFailure(input: {
	lane: RetentionTickLane
	failure: RetentionFailure
	scheduledAt: Date
	cron?: string
}): 'd1_lock_contention' | 'failed' {
	const { failure, lane } = input
	switch (failure.kind) {
		case 'd1_lock_contention':
			console.warn(
				`scheduled_lane_d1_lock_contention lane=${lane}`,
				failure.cause,
			)
			return 'd1_lock_contention'
		case 'd1_query_failed':
		case 'row_validation_failed':
		case 'timed_out':
		case 'aborted':
		case 'unexpected':
		case 'purge_webhook_failed': {
			const cause = reportableCause(failure)
			console.error(`scheduled_lane_failed lane=${lane}`, cause)
			Sentry.withScope((scope) => {
				scope.setTag('scheduled.lane', lane)
				scope.setTag('retention.failure_kind', failure.kind)
				scope.setContext('scheduled', {
					lane,
					scheduledTime: input.scheduledAt.toISOString(),
					cron: input.cron,
					operation: failure.operation,
				})
				Sentry.captureException(cause)
			})
			return 'failed'
		}
		default:
			return assertNever(failure)
	}
}
