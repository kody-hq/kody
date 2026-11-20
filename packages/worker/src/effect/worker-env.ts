import { Context, Layer } from 'effect'

/**
 * The Worker `env` the slice runs against. Bindings are read through this
 * service so an Effect program names the env it needs in its requirements
 * instead of threading it through every argument.
 */
export class WorkerEnv extends Context.Service<WorkerEnv, Env>()(
	'kody/effect/WorkerEnv',
) {
	static readonly layer = (env: Env) => Layer.succeed(WorkerEnv, env)
}
