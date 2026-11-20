import { Effect, type Exit, Option, type Scope } from 'effect'

/**
 * A row claim (a `deleting_at` stamp) held for the rest of the scope. The
 * `settle` policy runs on every exit, success, failure, or interruption, and
 * decides whether the claim is released or kept; it must not fail.
 */
export const scopedClaim = <A, E, R, R2>(
	acquire: Effect.Effect<Option.Option<A>, E, R>,
	settle: (
		claim: A,
		exit: Exit.Exit<unknown, unknown>,
	) => Effect.Effect<void, never, R2>,
): Effect.Effect<Option.Option<A>, E, R | R2 | Scope.Scope> =>
	Effect.acquireRelease(acquire, (claim, exit) =>
		Option.match(claim, {
			onNone: () => Effect.void,
			onSome: (held) => settle(held, exit),
		}),
	)

/** Claims the purge lanes keep on every exit: the 6 hour backoff owns retries. */
export const keepClaim =
	(lane: string) => (_claim: unknown, exit: Exit.Exit<unknown, unknown>) =>
		Effect.logDebug('purge claim kept', { lane, exit: exit._tag })
