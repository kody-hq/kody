import { Clock, Context, Effect, Layer } from 'effect'
import { D1, type DatabaseError, sql } from '#worker/effect/d1.ts'
import { runtimePerBinding } from '#worker/effect/runtime.ts'

export type RateLimitConfig = {
	maxRequests: number
	windowSeconds: number
}

export type RateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number | null
}

/**
 * D1-backed sliding-window limiter. The count check and the row write run in
 * one batch transaction, so concurrent requests cannot both take the last
 * slot. Blocked requests do not insert rows.
 */
export class RateLimiter extends Context.Service<
	RateLimiter,
	{
		check(
			key: string,
			config: RateLimitConfig,
		): Effect.Effect<RateLimitResult, DatabaseError>
		/** Refund the latest slot when the limited operation itself failed. */
		release(key: string): Effect.Effect<void, DatabaseError>
	}
>()('kody/effect/RateLimiter') {
	static readonly layer = Layer.effect(
		RateLimiter,
		Effect.gen(function* () {
			const d1 = yield* D1
			// Once per isolate and binding; a failed attempt is retried next call.
			const [cachedTable, invalidate] = yield* Effect.cachedInvalidateWithTTL(
				d1.batch('rate_limit.ensure_table', [
					sql(`CREATE TABLE IF NOT EXISTS _rate_limits (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						key TEXT NOT NULL,
						ts INTEGER NOT NULL
					)`),
					sql(
						`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON _rate_limits (key, ts)`,
					),
					sql(
						`CREATE INDEX IF NOT EXISTS idx_rate_limits_ts ON _rate_limits (ts)`,
					),
				]),
				Infinity,
			)
			const ensureTable = cachedTable.pipe(Effect.tapError(() => invalidate))

			return RateLimiter.of({
				check: Effect.fn('RateLimiter.check')(function* (key, config) {
					yield* ensureTable
					const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
					const windowStart = now - config.windowSeconds
					const [, insert] = yield* d1.batch('rate_limit.check', [
						sql(
							`DELETE FROM _rate_limits WHERE key = ? AND ts <= ?`,
							key,
							windowStart,
						),
						sql(
							`INSERT INTO _rate_limits (key, ts)
							SELECT ?, ?
							WHERE (SELECT COUNT(*) FROM _rate_limits WHERE key = ? AND ts > ?) < ?`,
							key,
							now,
							key,
							windowStart,
							config.maxRequests,
						),
					])
					const allowed = (insert?.changes ?? 0) > 0
					yield* Effect.annotateCurrentSpan('rate_limit.allowed', allowed)
					return allowed
						? { allowed, retryAfterSeconds: null }
						: { allowed, retryAfterSeconds: config.windowSeconds }
				}),
				release: Effect.fn('RateLimiter.release')(function* (key) {
					yield* ensureTable
					yield* d1.run(
						'rate_limit.release',
						sql(
							`DELETE FROM _rate_limits
							 WHERE id = (
								SELECT id FROM _rate_limits WHERE key = ? ORDER BY id DESC LIMIT 1
							 )`,
							key,
						),
					)
				}),
			})
		}),
	)
}

/** Promise edge for the non-Effect callers, one runtime per D1 binding. */
export const rateLimiterRuntime = runtimePerBinding((db: D1Database) =>
	RateLimiter.layer.pipe(Layer.provide(D1.layer(db))),
)
