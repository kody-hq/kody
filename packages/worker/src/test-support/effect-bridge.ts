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
	return (input: I) =>
		Effect.gen(function* () {
			const env = yield* WorkerEnv
			return yield* Effect.tryPromise({
				try: () => double({ ...input, env }),
				catch: (error) => error,
			})
		})
}
