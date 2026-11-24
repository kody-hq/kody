import { Data, Duration, Effect, Schedule } from 'effect'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
	isRetryableD1LockError,
} from '../d1-retry.ts'

/** A call that leaves the Worker failed or ran past its deadline. */
export class OutboundCallError extends Data.TaggedError('OutboundCallError')<{
	readonly operation: string
	readonly reason: 'failed' | 'timeout'
	readonly message: string
	readonly cause: unknown
}> {}

/** Per-binding deadlines, the same values the Promise helpers use. */
export const outboundTimeout = {
	d1: Duration.seconds(30),
	kv: Duration.seconds(15),
	queueSend: Duration.seconds(30),
	durableObject: Duration.seconds(150),
} as const

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause)

/**
 * The only way the consumer slices wrap a Promise API. The call gets an
 * AbortSignal that fires on timeout or interruption, a typed failure, and a
 * span. There is no default deadline.
 */
export const outbound = <A>(
	operation: string,
	evaluate: (signal: AbortSignal) => PromiseLike<A> | A,
	options: { readonly timeout: Duration.Input },
): Effect.Effect<A, OutboundCallError> =>
	// effect-check: allow this is outbound()
	Effect.tryPromise({
		try: async (signal) => evaluate(signal),
		catch: (cause) =>
			new OutboundCallError({
				operation,
				reason: 'failed',
				message: messageOf(cause),
				cause,
			}),
	}).pipe(
		Effect.timeoutOrElse({
			duration: options.timeout,
			orElse: () =>
				Effect.fail(
					new OutboundCallError({
						operation,
						reason: 'timeout',
						message: `${operation} timed out after ${Duration.format(Duration.fromInputUnsafe(options.timeout))}.`,
						cause: null,
					}),
				),
		}),
		Effect.withSpan(operation, { attributes: { 'kody.outbound': true } }),
	)

/** The error a caller would have seen from the Promise API, for logs and retry text. */
export const outboundCause = (error: OutboundCallError) =>
	error.reason === 'failed' ? error.cause : error

/**
 * A D1 call with a per-attempt deadline, retried on lock and storage
 * contention the way `runD1WithRetry` does (6 attempts, 150 ms doubling).
 */
export const d1 = <A>(
	operation: string,
	evaluate: (signal: AbortSignal) => PromiseLike<A> | A,
): Effect.Effect<A, OutboundCallError> =>
	outbound(operation, evaluate, { timeout: outboundTimeout.d1 }).pipe(
		Effect.retry({
			schedule: Schedule.exponential(Duration.millis(d1LockRetryBaseDelayMs)),
			times: d1LockRetryMaxAttempts - 1,
			while: (error) =>
				error.reason === 'failed' && isRetryableD1LockError(error.cause),
		}),
	)
