import type { Effect } from 'effect'
import type { D1 } from '#worker/effect/d1.ts'
import type { SliceServices } from '#worker/effect/slice.ts'

/**
 * `runSlicePromise` and `runD1Promise`, loaded on first call. Modules that
 * much of the worker imports (the org audit outbox, lane leases) use these so
 * importing them does not pull the whole slice runtime into their graph.
 */
export const runSlicePromiseLazy = async <A, E>(
	env: Env,
	effect: Effect.Effect<A, E, SliceServices>,
): Promise<A> =>
	(await import('#worker/effect/slice.ts')).runSlicePromise(env, effect)

export const runD1PromiseLazy = async <A, E>(
	database: D1Database,
	effect: (db: D1['Service']) => Effect.Effect<A, E>,
): Promise<A> =>
	(await import('#worker/effect/slice.ts')).runD1Promise(database, effect)
