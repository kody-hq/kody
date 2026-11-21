import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { Duration, Effect, Schema } from 'effect'

/**
 * A call that leaves the isolate (Durable Object RPC, KV, R2, Vectorize,
 * service binding, fetch) failed or ran past its deadline. `message` is the
 * underlying error's message so warnings and audit details read the same as
 * the error that caused them.
 */
export class OutboundCallError extends Schema.TaggedError<OutboundCallError>()(
	'OutboundCallError',
	{
		operation: Schema.String,
		reason: Schema.Literals(['failed', 'timeout']),
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export const outboundCallTimeout = Duration.seconds(30)

/**
 * Every outbound call in the slice goes through here: the call gets the
 * fiber's `AbortSignal` (aborted when the deadline interrupts it), a span, and
 * a typed failure.
 */
export const outbound = <A>(
	operation: string,
	evaluate: (signal: AbortSignal) => PromiseLike<A>,
	options?: { readonly timeout?: Duration.Input },
): Effect.Effect<A, OutboundCallError> => {
	const timeout = options?.timeout ?? outboundCallTimeout
	return Effect.tryPromise({
		try: evaluate,
		catch: (cause) =>
			new OutboundCallError({
				operation,
				reason: 'failed',
				message: getErrorMessage(cause),
				cause,
			}),
	}).pipe(
		Effect.timeoutOrElse({
			duration: timeout,
			orElse: () =>
				Effect.fail(
					new OutboundCallError({
						operation,
						reason: 'timeout',
						message: `${operation} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}.`,
						cause: null,
					}),
				),
		}),
		Effect.withSpan(operation, { attributes: { 'kody.outbound': true } }),
	)
}
