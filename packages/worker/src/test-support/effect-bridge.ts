import { Effect } from 'effect'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

/**
 * Adapts a Promise test double (`vi.fn`) that takes `{ env, ...input }` into
 * the Effect it replaces: the env comes from `WorkerEnv`, and a rejection
 * becomes a typed failure so tagged errors keep their `_tag`.
 */
export function promiseDouble<I extends object, A>(
	double: (input: I & { env: Env }) => Promise<A>,
) {
	return (input: Omit<I, 'env'>) =>
		Effect.gen(function* () {
			const env = yield* WorkerEnv
			// A test double's rejection passes through as-is so tagged errors keep
			// their `_tag` and class for the code under test.
			// @effect-diagnostics-next-line unknownInEffectCatch:off
			return yield* Effect.tryPromise({
				try: () => double({ ...input, env } as I & { env: Env }),
				catch: (error) => error,
			})
		})
}

/** Adapts a Promise test double into an Effect that never fails. */
export function promiseEffect<I extends Array<unknown>, A>(
	double: (...input: I) => Promise<A>,
) {
	return (...input: I) => Effect.promise(() => double(...input))
}
