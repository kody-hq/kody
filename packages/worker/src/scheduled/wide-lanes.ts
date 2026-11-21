import * as Sentry from '@sentry/cloudflare'
import {
	applyPacedRestoreDrillSentryScope,
	classifyPacedRestoreDrillFailure,
	pacedRestoreDrillLane,
} from '@kody-internal/shared/backup-d1-paced-drill-alert.ts'
import type {
	ScheduledLaneMessage,
	ScheduledLaneName,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { Effect, Option, Schema } from 'effect'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import { D1PacedRestoreDrillError } from '#worker/dr/d1-paced-restore-drill.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { runSlicePromise } from '#worker/effect/slice.ts'
import { sweepStaleInboundDeliveriesEffect } from '#worker/email/reconcile-inbound-deliveries.ts'
import { pruneSystemEmailRetentionEffect } from '#worker/email/system-email.ts'
import { runOAuthPurgeLaneEffect } from '#worker/oauth-purge.ts'
import { drainOrgAuditOutboxEffect } from '#worker/orgs/org-audit-outbox.ts'
import { cleanupRepoSessionBranchesEffect } from '#worker/repo/repo-session-cleanup.ts'
import {
	scheduledLaneLeaseMs,
	scopedScheduledLaneLease,
} from './scheduled-lane-lease.ts'

/**
 * The Effect trial switch for the wide lanes. Only the string "1" selects
 * the Effect path; unset or any other value keeps the Promise path.
 */
export function effectTrialWideLanesEnabled(env: Env) {
	return (
		(env as Env & { EFFECT_TRIAL_WIDE_LANES?: unknown })
			.EFFECT_TRIAL_WIDE_LANES === '1'
	)
}

export const wideLanes = [
	'repo_session_cleanup',
	'reconcile_inbound_deliveries',
	'system_email_retention',
	'org_audit_outbox',
	'oauth_purge_expired',
] as const

export type WideLane = (typeof wideLanes)[number]

export function isWideLane(lane: string): lane is WideLane {
	return (wideLanes as ReadonlyArray<string>).includes(lane)
}

/** A Promise lane run inside the Effect wrapper rejected. */
export class ScheduledLaneError extends Schema.TaggedError<ScheduledLaneError>()(
	'ScheduledLaneError',
	{
		lane: Schema.String,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export const runWideLaneEffect = Effect.fn('WideLanes.run')(function* (
	lane: WideLane,
	scheduledAt: Date,
) {
	yield* Effect.annotateCurrentSpan('scheduled.lane', lane)
	switch (lane) {
		case 'repo_session_cleanup':
			return yield* cleanupRepoSessionBranchesEffect({ now: scheduledAt })
		case 'reconcile_inbound_deliveries':
			return yield* sweepStaleInboundDeliveriesEffect({ now: scheduledAt })
		case 'system_email_retention': {
			const env = yield* WorkerEnv
			return yield* pruneSystemEmailRetentionEffect({
				db: env.APP_DB,
				blobs: env.EMAIL_BLOBS,
				now: scheduledAt,
			})
		}
		case 'org_audit_outbox':
			return yield* drainOrgAuditOutboxEffect({ now: scheduledAt })
		case 'oauth_purge_expired':
			return yield* runOAuthPurgeLaneEffect({ scheduledAt })
	}
})

type WideLaneFailure =
	| Effect.Error<ReturnType<typeof runWideLaneEffect>>
	| ScheduledLaneError

/**
 * The error the scheduled-lane isolation classifies and reports: a D1 or
 * outbound failure unwraps to the driver error so lock contention is still
 * recognized; timeouts and schema drift stay tagged. A new failure tag
 * without a case here fails to compile.
 */
export function toWideLaneFailure(error: WideLaneFailure): unknown {
	switch (error._tag) {
		case 'DatabaseError':
			return error.reason === 'query' ? error.cause : error
		case 'OutboundCallError':
			return error.reason === 'failed' ? error.cause : error
		case 'ScheduledLaneError':
			return error.cause
		case 'SystemEmailAuthorityError':
			return error
		default: {
			const unmapped: never = error
			return unmapped
		}
	}
}

/** The Promise edge `runScheduledLane` uses when the trial switch is on. */
export function runWideLane(input: {
	env: Env
	lane: WideLane
	scheduledAt: Date
}): Promise<unknown> {
	return runSlicePromise(
		input.env,
		runWideLaneEffect(input.lane, input.scheduledAt).pipe(
			Effect.mapError(toWideLaneFailure),
		),
	)
}

type LaneOutcome = 'completed' | 'd1_lock_contention' | 'failed'

const reportLaneFailure = (message: ScheduledLaneMessage, error: unknown) =>
	Effect.sync((): LaneOutcome => {
		if (isRetryableD1LockError(error)) {
			console.warn(
				`scheduled_lane_d1_lock_contention lane=${message.lane}`,
				error,
			)
			return 'd1_lock_contention'
		}
		console.error(`scheduled_lane_failed lane=${message.lane}`, error)
		try {
			Sentry.withScope((scope) => {
				scope.setTag('scheduled.lane', message.lane)
				scope.setContext('scheduled', {
					lane: message.lane,
					scheduledTime: new Date(message.scheduledTime).toISOString(),
					cron: message.cron,
				})
				if (message.lane === pacedRestoreDrillLane) {
					applyPacedRestoreDrillSentryScope(scope, {
						kind:
							error instanceof D1PacedRestoreDrillError
								? error.kind
								: classifyPacedRestoreDrillFailure(error),
						checkpoint:
							error instanceof D1PacedRestoreDrillError
								? error.checkpoint
								: null,
					})
				}
				Sentry.captureException(error)
			})
		} catch (reportError) {
			console.warn('scheduled_lane_sentry_report_failed', {
				lane: message.lane,
				error: getErrorMessage(reportError),
			})
		}
		return 'failed'
	})

/**
 * `runScheduledLaneWithFailureIsolation` as an Effect. The lane lease is a
 * scoped resource, so it is released however the lane ends; every typed
 * failure maps to an outcome and never escapes.
 */
export const runScheduledLaneWithFailureIsolationEffect = Effect.fn(
	'ScheduledLanes.runWithFailureIsolation',
)(function* (
	message: ScheduledLaneMessage,
	runPromiseLane: (input: {
		env: Env
		lane: ScheduledLaneName
		scheduledAt: Date
	}) => Promise<unknown>,
) {
	const env = yield* WorkerEnv
	const lane = message.lane
	const scheduledAt = new Date(message.scheduledTime)
	yield* Effect.annotateCurrentSpan('scheduled.lane', lane)
	const leaseMs = scheduledLaneLeaseMs[lane]
	const runLane = isWideLane(lane)
		? runWideLaneEffect(lane, scheduledAt)
		: Effect.tryPromise({
				try: () => runPromiseLane({ env, lane, scheduledAt }),
				catch: (cause) =>
					new ScheduledLaneError({
						lane,
						message: getErrorMessage(cause),
						cause,
					}),
			})
	return yield* Effect.scoped(
		Effect.gen(function* () {
			if (leaseMs !== undefined) {
				const lease = yield* scopedScheduledLaneLease({ lane, leaseMs })
				if (Option.isNone(lease)) {
					console.warn('scheduled_lane_skipped_overlap', {
						lane,
						scheduledTime: scheduledAt.toISOString(),
					})
					return 'completed' as const
				}
			}
			yield* runLane
			return 'completed' as const
		}),
	).pipe(
		Effect.catch((error: WideLaneFailure) =>
			reportLaneFailure(message, toWideLaneFailure(error)),
		),
	)
})

/** The Promise edge the wrapper uses when the trial switch is on. */
export function runScheduledLaneWithFailureIsolationViaEffect(input: {
	env: Env
	message: ScheduledLaneMessage
	runPromiseLane: (input: {
		env: Env
		lane: ScheduledLaneName
		scheduledAt: Date
	}) => Promise<unknown>
}): Promise<LaneOutcome> {
	return runSlicePromise(
		input.env,
		runScheduledLaneWithFailureIsolationEffect(
			input.message,
			input.runPromiseLane,
		),
	)
}
