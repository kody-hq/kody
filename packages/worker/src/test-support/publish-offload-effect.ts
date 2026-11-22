import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { D1 } from '#worker/effect/d1.ts'
import { ErrorReporter } from '#worker/effect/error-reporter.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import {
	PublishBuildBucket,
	type publishOffloadLayer,
} from '#worker/publish-offload/services.ts'

type PublishOffloadServices = Layer.Success<
	ReturnType<typeof publishOffloadLayer>
>

/**
 * Runs a publish offload effect against test bindings, the way the Worker
 * edges run it against `env`. `now` pins `Clock` for the whole run.
 */
export async function runPublishOffload<A, E>(
	effect: Effect.Effect<A, E, PublishOffloadServices>,
	bindings: {
		env?: Env
		db?: D1Database
		bucket?: R2Bucket
		now?: number
	} = {},
): Promise<A> {
	const env = bindings.env ?? ({} as Env)
	const layer = Layer.mergeAll(
		WorkerEnv.layer(env),
		D1.layer(bindings.db ?? env.APP_DB),
		PublishBuildBucket.layer(bindings.bucket ?? env.REPO_SESSION_BLOBS),
		ErrorReporter.layer,
	)
	const now = bindings.now
	const program =
		now === undefined
			? effect
			: Effect.andThen(TestClock.setTime(now), effect).pipe(
					Effect.provide(TestClock.layer()),
				)
	return await Effect.runPromise(program.pipe(Effect.provide(layer)))
}
