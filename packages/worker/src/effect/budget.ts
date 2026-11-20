import { Clock, Duration, Effect } from 'effect'

/**
 * A wall-clock budget for one lane pass, read from `Clock` so tests drive it
 * with `TestClock`. `exceeded` is true once more than the budget has elapsed;
 * `reached` is true once the budget has fully elapsed.
 */
export type PassBudget = {
	readonly elapsed: Effect.Effect<Duration.Duration>
	readonly reached: Effect.Effect<boolean>
	readonly exceeded: Effect.Effect<boolean>
}

export const startPassBudget = Effect.fnUntraced(function* (
	budget: Duration.Input,
) {
	const limitMs = Duration.toMillis(Duration.fromInputUnsafe(budget))
	const startedAtMs = yield* Clock.currentTimeMillis
	const elapsedMs = Effect.map(
		Clock.currentTimeMillis,
		(nowMs) => nowMs - startedAtMs,
	)
	return {
		elapsed: Effect.map(elapsedMs, Duration.millis),
		reached: Effect.map(elapsedMs, (ms) => ms >= limitMs),
		exceeded: Effect.map(elapsedMs, (ms) => ms > limitMs),
	} satisfies PassBudget
})
