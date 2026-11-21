import {
	durableObjectResetRetryDelaysMs,
	isTransientDurableObjectResetError,
} from '#worker/durable-object-reset-retry.ts'
import { Duration, Effect, Schedule } from 'effect'
import type { OutboundCallError } from '#worker/effect/outbound.ts'

/**
 * `durableObjectResetRetryDelaysMs` as a schedule: one retry per listed
 * delay, then the last failure is returned.
 */
export const durableObjectResetSchedule = Schedule.recurs(
	durableObjectResetRetryDelaysMs.length,
).pipe(
	Schedule.addDelay(({ attempt }) =>
		Effect.succeed(
			Duration.millis(durableObjectResetRetryDelaysMs[attempt - 1] ?? 0),
		),
	),
)

/** Retries an outbound Durable Object call across platform isolate resets. */
export const retryDurableObjectReset = <A, R>(
	effect: Effect.Effect<A, OutboundCallError, R>,
): Effect.Effect<A, OutboundCallError, R> =>
	Effect.retry(effect, {
		schedule: durableObjectResetSchedule,
		while: (error: OutboundCallError) =>
			error.reason === 'failed' &&
			isTransientDurableObjectResetError(error.cause),
	})
