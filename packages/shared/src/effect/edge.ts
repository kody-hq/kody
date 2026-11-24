import { Cause, Effect, Exit, Logger } from 'effect'
import { OutboundCallError, outboundCause } from './outbound.ts'

/**
 * `Effect.logError('event', details)` writes `console.error('event', details)`,
 * the shape the consumers already log and the tests already assert.
 */
const consumerLogger = Logger.make(({ logLevel, message }) => {
	const [event, ...details] = Array.isArray(message) ? message : [message]
	if (logLevel === 'Fatal' || logLevel === 'Error') {
		// effect-check: allow the logger is where Effect.log reaches the console
		console.error(event, ...details)
	} else if (logLevel === 'Warn') {
		// effect-check: allow the logger is where Effect.log reaches the console
		console.warn(event, ...details)
	} else {
		// effect-check: allow the logger is where Effect.log reaches the console
		console.info(event, ...details)
	}
})

const consumerLoggerLayer = Logger.layer([consumerLogger])

/**
 * The Promise edge for queue handlers, Durable Object methods, and crons. A
 * typed `OutboundCallError` rejects with the error the Promise API threw, so
 * callers and the runtime see the same failure as before.
 */
export async function runEdge<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	// effect-check: allow this is runEdge
	const exit = await Effect.runPromiseExit(
		effect.pipe(Effect.provide(consumerLoggerLayer)),
	)
	if (Exit.isSuccess(exit)) return exit.value
	const failure = Cause.squash(exit.cause)
	throw failure instanceof OutboundCallError ? outboundCause(failure) : failure
}
