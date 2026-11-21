import { Context, Effect, Fiber, Layer } from 'effect'

/**
 * The request's `waitUntil`, as a requirement. Work that must outlive the
 * response (audit writes, mail delivery reports, package dispatch tails)
 * declares `Background` in its type, so it cannot run without a registered
 * hook. Provided per request, never captured in an isolate-lifetime layer.
 */
export class Background extends Context.Service<
	Background,
	{ readonly waitUntil: (promise: Promise<unknown>) => void }
>()('kody/effect/Background') {
	static readonly layer = (waitUntil: (promise: Promise<unknown>) => void) =>
		Layer.succeed(Background, Background.of({ waitUntil }))
}

/**
 * Fork `effect` past the response and register it with `waitUntil`. A failure
 * is logged on the span, never surfaced to the request.
 */
export const forkBackground = Effect.fnUntraced(function* <E, R>(
	name: string,
	effect: Effect.Effect<unknown, E, R>,
) {
	const { waitUntil } = yield* Background
	const fiber = yield* Effect.forkDetach(
		effect.pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(`${name} failed in background`, cause),
			),
			Effect.withSpan(name),
		),
	)
	// The bridge to the platform hook: `waitUntil` takes a Promise.
	// @effect-diagnostics-next-line runEffectInsideEffect:off
	waitUntil(Effect.runPromise(Fiber.await(fiber)))
})

/**
 * For Promise callers with no `waitUntil` of their own: hand `run` a
 * `Background` layer and resolve only once every fork it registered settled.
 */
export async function runAwaitingBackground<A>(
	run: (background: Layer.Layer<Background>) => Promise<A>,
) {
	const pending: Array<Promise<unknown>> = []
	try {
		return await run(Background.layer((promise) => void pending.push(promise)))
	} finally {
		await Promise.allSettled(pending)
	}
}
