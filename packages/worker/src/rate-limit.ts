export type RateLimitConfig = {
	maxRequests: number
	windowSeconds: number
}

export type RateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number | null
}

const initializedDbs = new WeakSet<D1Database>()

async function ensureRateLimitTable(db: D1Database) {
	if (initializedDbs.has(db)) return
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS _rate_limits (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL,
				ts INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON _rate_limits (key, ts)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_rate_limits_ts ON _rate_limits (ts)`,
		),
	])
	initializedDbs.add(db)
}

/**
 * D1-backed rate limiter. Uses a conditional INSERT inside a single
 * batch transaction so the count check and the row write are atomic
 * — no TOCTOU gap for concurrent requests to exploit. Blocked
 * requests do not insert rows.
 */
export async function checkRateLimit(
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	await ensureRateLimitTable(db)

	const now = Math.floor(Date.now() / 1000)
	const windowStart = now - config.windowSeconds

	const results = await db.batch([
		db
			.prepare(`DELETE FROM _rate_limits WHERE key = ? AND ts <= ?`)
			.bind(key, windowStart),
		db
			.prepare(
				`INSERT INTO _rate_limits (key, ts)
				SELECT ?, ?
				WHERE (SELECT COUNT(*) FROM _rate_limits WHERE key = ? AND ts > ?) < ?`,
			)
			.bind(key, now, key, windowStart, config.maxRequests),
	])

	const insertMeta = results[1]?.meta
	const inserted = (insertMeta?.changes ?? 0) > 0

	if (!inserted) {
		return {
			allowed: false,
			retryAfterSeconds: config.windowSeconds,
		}
	}

	return { allowed: true, retryAfterSeconds: null }
}

/**
 * Refund the most recent slot consumed for `key`. Use when the
 * rate-limited operation itself failed, so transient downstream errors
 * do not eat into the caller's allowance.
 */
export async function releaseRateLimit(db: D1Database, key: string) {
	await ensureRateLimitTable(db)
	await db
		.prepare(
			`DELETE FROM _rate_limits
			 WHERE id = (
				SELECT id FROM _rate_limits WHERE key = ? ORDER BY id DESC LIMIT 1
			 )`,
		)
		.bind(key)
		.run()
}
