import { Context, Effect, Layer } from 'effect'

const supervise = <E>(name: string, task: Effect.Effect<void, E>) =>
	task.pipe(
		Effect.catchCause((cause) => Effect.logError(`${name} failed`, cause)),
		Effect.withSpan(name),
	)

/**
 * Work that may outlive the response (audit writes, mail follow-ups). Each
 * task runs supervised: failures are logged, never rethrown, and the
 * Workers runtime is told to keep the isolate alive until it settles.
 */
export class Background extends Context.Service<
	Background,
	{
		readonly fork: <E>(
			name: string,
			task: Effect.Effect<void, E>,
		) => Effect.Effect<void>
		/** For Promise APIs that take a `waitUntil` callback (mailer, package dispatch). */
		readonly waitUntil: (promise: Promise<unknown>) => void
	}
>()('kody/effect/Background') {
	static layer(waitUntil: (promise: Promise<unknown>) => void) {
		return Layer.succeed(
			Background,
			Background.of({
				fork: (name, task) =>
					Effect.context<never>().pipe(
						Effect.map((context) =>
							waitUntil(Effect.runPromiseWith(context)(supervise(name, task))),
						),
					),
				waitUntil,
			}),
		)
	}

	/** Runs tasks before the caller continues; for tests and queue batches. */
	static readonly inline = Layer.succeed(
		Background,
		Background.of({
			fork: supervise,
			waitUntil: () => {},
		}),
	)
}
