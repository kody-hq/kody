export const packageAppRateLimitBounds = {
	limitMin: 1,
	limitMax: 1_000_000,
	windowSecondsMin: 1,
	windowSecondsMax: 86_400,
	keyMaxLength: 256,
} as const

async function hashKey(key: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(key),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export async function packageAppRateLimitStorageKey(
	packageId: string,
	key: string,
	windowSeconds: number,
) {
	return `${packageId}:${windowSeconds}:${await hashKey(key)}`
}

export async function checkPackageAppRateLimit(input: {
	db: D1Database
	packageId: string
	key: unknown
	limit: unknown
	windowSeconds: unknown
	nowMilliseconds?: number
}) {
	if (
		typeof input.key !== 'string' ||
		input.key.length > packageAppRateLimitBounds.keyMaxLength ||
		!Number.isInteger(input.limit) ||
		(input.limit as number) < packageAppRateLimitBounds.limitMin ||
		(input.limit as number) > packageAppRateLimitBounds.limitMax ||
		!Number.isInteger(input.windowSeconds) ||
		(input.windowSeconds as number) <
			packageAppRateLimitBounds.windowSecondsMin ||
		(input.windowSeconds as number) > packageAppRateLimitBounds.windowSecondsMax
	) {
		throw new Error('appRateLimit received invalid arguments.')
	}
	const storageKey = await packageAppRateLimitStorageKey(
		input.packageId,
		input.key,
		input.windowSeconds as number,
	)
	const windowSeconds = input.windowSeconds as number
	const now = Math.floor((input.nowMilliseconds ?? Date.now()) / 1000)
	const windowStart = Math.floor(now / windowSeconds) * windowSeconds
	const resetAt = new Date((windowStart + windowSeconds) * 1000).toISOString()
	const row = await input.db
		.prepare(
			`INSERT INTO package_app_rate_limits (bucket_key, window_start, count)
			 VALUES (?, ?, 1)
			 ON CONFLICT (bucket_key) DO UPDATE SET
			   count = CASE
			     WHEN window_start = excluded.window_start THEN count + 1
			     ELSE 1
			   END,
			   window_start = excluded.window_start
			 WHERE window_start <> excluded.window_start OR count < ?
			 RETURNING count`,
		)
		.bind(storageKey, windowStart, input.limit)
		.first<{ count: number }>()
	const allowed = row !== null
	const count = row?.count ?? (input.limit as number)
	return {
		allowed,
		remaining: allowed ? Math.max(0, (input.limit as number) - count) : 0,
		resetAt,
		retryAfterSeconds: allowed
			? null
			: Math.max(1, windowStart + windowSeconds - now),
	}
}
