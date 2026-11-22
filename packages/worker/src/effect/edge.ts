import { Cause, Exit, type Effect, type ManagedRuntime } from 'effect'
import type { DatabaseError } from './d1.ts'
import type { OutboundCallError } from './outbound.ts'

/**
 * Runs an Effect program at a Promise boundary. Every typed failure goes
 * through `onFailure`, which the caller builds with `Match.tagsExhaustive`
 * so a failure added to the program without a mapping is a compile error.
 * `onFailure` returns the boundary's answer or throws the boundary's error.
 * Defects and interruptions rethrow their original cause.
 */
export async function runEdge<A, E, R>(
	runtime: ManagedRuntime.ManagedRuntime<R, never>,
	effect: Effect.Effect<A, E, R>,
	onFailure: (error: E) => A,
): Promise<A> {
	const exit = await runtime.runPromiseExit(effect)
	if (Exit.isSuccess(exit)) return exit.value
	const failure = Cause.findErrorOption(exit.cause)
	if (failure._tag === 'Some') return onFailure(failure.value)
	throw Cause.squash(exit.cause)
}

/**
 * An infrastructure failure leaves the edge as the error the wrapped call
 * threw, so the caller's existing mapping (`toApiError`, MCP errors) sees
 * exactly what it saw before. A deadline or row-shape failure has no
 * original error and leaves as itself (a 500).
 */
export const rethrow = (error: DatabaseError | OutboundCallError): never => {
	throw error.reason === 'failed' || error.reason === 'query'
		? error.cause
		: error
}
