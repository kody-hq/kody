import { Context, Duration, Effect, Layer, Option, Ref, Schema } from 'effect'

/** Platform blips worth another try; any other storage failure is permanent. */
const transientStorageMarkers = [
	'Network connection lost',
	'storage operation exceeded timeout',
	'D1_ERROR: internal error',
	// R2 internal error
	'(10001)',
] as const

export const transientRetryDelaysMs = [50, 100, 200] as const

/** Total backoff one request may spend across all of its storage calls. */
export const transientRetryBudgetMs = 400

export const isTransientStorageError = (error: { readonly message: string }) =>
	transientStorageMarkers.some((marker) => error.message.includes(marker))

/** A request spent its retry budget on transient storage failures (503). */
export class TransientRetryBudgetExhausted extends Schema.TaggedError<TransientRetryBudgetExhausted>()(
	'TransientRetryBudgetExhausted',
	{ label: Schema.String, message: Schema.String },
) {}

/**
 * The backoff one request has spent so far. Provide `layer` once per request
 * so every call in it draws from one budget. A call with no budget in scope
 * runs once, as it did before retries existed.
 */
export class TransientRetryBudget extends Context.Service<
	TransientRetryBudget,
	{ readonly spentMs: Ref.Ref<number> }
>()('kody/effect/TransientRetryBudget') {
	static readonly layer = Layer.effect(
		TransientRetryBudget,
		Effect.map(Ref.make(0), (spentMs) => TransientRetryBudget.of({ spentMs })),
	)
}

/**
 * Retries one D1 statement or R2 call while it fails transiently, waiting
 * `transientRetryDelaysMs` between attempts. A wait that would take the
 * request past `transientRetryBudgetMs` fails `TransientRetryBudgetExhausted`
 * instead; a call that stays transient through every retry fails as itself.
 */
export const retryTransient = <A, E extends { readonly message: string }, R>(
	label: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TransientRetryBudgetExhausted, R> =>
	Effect.flatMap(Effect.serviceOption(TransientRetryBudget), (budget) => {
		if (Option.isNone(budget)) return effect
		const { spentMs } = budget.value
		const attempt = (
			retry: number,
		): Effect.Effect<A, E | TransientRetryBudgetExhausted, R> =>
			Effect.catchIf(effect, isTransientStorageError, (error) => {
				const delayMs = transientRetryDelaysMs[retry]
				if (delayMs === undefined) return Effect.fail(error)
				return Ref.modify(spentMs, (spent) =>
					spent + delayMs > transientRetryBudgetMs
						? [false, spent]
						: [true, spent + delayMs],
				).pipe(
					Effect.flatMap((withinBudget) =>
						withinBudget
							? Effect.logInfo('transient_storage_retry', {
									label,
									retry: retry + 1,
									delayMs,
									message: error.message,
								}).pipe(
									Effect.andThen(Effect.sleep(Duration.millis(delayMs))),
									Effect.andThen(attempt(retry + 1)),
								)
							: Effect.fail(
									new TransientRetryBudgetExhausted({
										label,
										message: `Storage stayed busy at ${label}: ${error.message}`,
									}),
								),
					),
				)
			})
		return attempt(0)
	})
