import { Context, Layer } from 'effect'
import { D1 } from '#worker/effect/d1.ts'
import { ErrorReporter } from '#worker/effect/error-reporter.ts'
import { makeR2Client, type R2Client } from '#worker/effect/r2.ts'
import { runtimePerEnv } from '#worker/effect/runtime.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

/** `REPO_SESSION_BLOBS`: publish build chunks and sealed documents. */
export class PublishBuildBucket extends Context.Service<
	PublishBuildBucket,
	R2Client
>()('kody/publish-offload/PublishBuildBucket') {
	static readonly layer = (bucket: R2Bucket) =>
		Layer.succeed(
			PublishBuildBucket,
			makeR2Client(() => bucket),
		)
}

/** What the publish offload path runs against in a Worker or RepoSession. */
export const publishOffloadLayer = (env: Env) =>
	Layer.mergeAll(
		WorkerEnv.layer(env),
		D1.layer(env.APP_DB),
		PublishBuildBucket.layer(env.REPO_SESSION_BLOBS),
		ErrorReporter.layer,
	)

export type PublishOffloadServices = Layer.Success<
	ReturnType<typeof publishOffloadLayer>
>

/** One runtime per Worker `env` identity, built on first use per isolate. */
export const publishOffloadRuntime = runtimePerEnv(publishOffloadLayer)
