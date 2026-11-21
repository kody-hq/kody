import { Clock, Context, Effect, Layer } from 'effect'
import { D1, type DatabaseError } from '#worker/effect/d1.ts'
import type { RateLimitConfig } from '#worker/rate-limit.ts'

/**
 * The shared `_rate_limits` sliding window on Effect's `Clock`: a conditional
 * INSERT inside one batch keeps the count check and the write atomic.
 */
export class RateLimiter extends Context.Service<
	RateLimiter,
	{
		readonly consume: (
			key: string,
			config: RateLimitConfig,
		) => Effect.Effect<boolean, DatabaseError>
	}
>()('kody/newsletter/RateLimiter') {
	static readonly layer = Layer.effect(
		RateLimiter,
		Effect.gen(function* () {
			const d1 = yield* D1
			const ensureTable = yield* Effect.cached(
				d1.batch('rateLimit.ensureTable', [
					{
						sql: `CREATE TABLE IF NOT EXISTS _rate_limits (
							id INTEGER PRIMARY KEY AUTOINCREMENT,
							key TEXT NOT NULL,
							ts INTEGER NOT NULL
						)`,
					},
					{
						sql: `CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON _rate_limits (key, ts)`,
					},
					{
						sql: `CREATE INDEX IF NOT EXISTS idx_rate_limits_ts ON _rate_limits (ts)`,
					},
				]),
			)
			return RateLimiter.of({
				consume: Effect.fn('RateLimiter.consume')(function* (key, config) {
					yield* ensureTable
					const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
					const windowStart = now - config.windowSeconds
					const [, insert] = yield* d1.batch('rateLimit.consume', [
						{
							sql: `DELETE FROM _rate_limits WHERE key = ? AND ts <= ?`,
							params: [key, windowStart],
						},
						{
							sql: `INSERT INTO _rate_limits (key, ts)
								SELECT ?, ?
								WHERE (SELECT COUNT(*) FROM _rate_limits WHERE key = ? AND ts > ?) < ?`,
							params: [key, now, key, windowStart, config.maxRequests],
						},
					])
					return (insert?.changes ?? 0) > 0
				}),
			})
		}),
	)
}
