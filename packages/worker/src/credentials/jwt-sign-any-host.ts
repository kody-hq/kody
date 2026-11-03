/**
 * Any-host `secretJwtSign` callers until `send_to_host` is required
 * (kody-hq/kody#4456). A caller is an owner org plus the attested package
 * ('' for execute code outside a package).
 *
 * - Every pair making any-host calls before the new-caller cutoff
 *   (2026-11-10 America/Denver) is grandfathered until `send_to_host` is
 *   required; a pair first seen after the cutoff is refused.
 * - The host each any-host JWT is filled on is counted per pair, so a pair
 *   whose JWTs only ever went to one registrable domain gets `send_to_host`
 *   filled in server-side once it is required.
 *
 * Rows live in APP_DB (`jwt_sign_any_host_callers`,
 * `jwt_sign_any_host_destinations`); nothing here holds a JWT.
 */
import { queryAnalyticsEngineSql } from '#worker/usage/aggregate-rollups.ts'
import { sealedTokenDomainForUrl } from './sealed-token.ts'

/** Pairs not seen making any-host calls before this are refused. */
export const jwtSignNewAnyHostCallerCutoffDate = '2026-11-10'
/** Midnight America/Denver (MST, UTC-7) on the cutoff date. */
export const jwtSignNewAnyHostCallerCutoffAt = Date.parse(
	`${jwtSignNewAnyHostCallerCutoffDate}T00:00:00-07:00`,
)

export const jwtSignAnyHostEventKinds = {
	/** A grandfathered pair got an any-host JWT. */
	sealed: 'jwt_sign_any_host',
	/** A pair was refused for leaving out `send_to_host`. */
	refused: 'jwt_sign_any_host_refused',
	/** Kody filled in `send_to_host` from the pair's only destination. */
	inferred: 'jwt_sign_any_host_inferred',
} as const

export type JwtSignAnyHostEventKind =
	(typeof jwtSignAnyHostEventKinds)[keyof typeof jwtSignAnyHostEventKinds]

export type JwtSignAnyHostCaller = { ownerId: string; packageId: string }

type AnalyticsEnv = Pick<Env, 'JWT_SIGN_ANY_HOST_EVENTS'> & {
	WRANGLER_IS_LOCAL_DEV?: string
	SENTRY_ENVIRONMENT?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
}

type CallerEnv = Pick<Env, 'APP_DB'> & AnalyticsEnv

/** A refused pair is re-checked after this, in case Analytics Engine lagged. */
const refusedRecheckMs = 60 * 60 * 1000
/** Analytics Engine keeps three months; the window only needs the deprecation. */
const grandfatherLookbackDays = 90
const analyticsIdPattern = /^[A-Za-z0-9_.:-]*$/

/** The Analytics Engine SQL table `JWT_SIGN_ANY_HOST_EVENTS` writes to. */
export function resolveJwtSignAnyHostDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_jwt_sign_any_host_events_preview'
		: 'kody_jwt_sign_any_host_events'
}

/** One Analytics Engine point per any-host call outcome. Never throws. */
export function recordJwtSignAnyHostEvent(input: {
	env: AnalyticsEnv
	kind: JwtSignAnyHostEventKind
	caller: JwtSignAnyHostCaller
}) {
	try {
		if (!input.env.JWT_SIGN_ANY_HOST_EVENTS) return
		if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') return
		input.env.JWT_SIGN_ANY_HOST_EVENTS.writeDataPoint({
			indexes: [input.caller.ownerId],
			blobs: [input.kind, input.caller.ownerId, input.caller.packageId],
			doubles: [1],
		})
	} catch (error) {
		console.warn('jwt-sign-any-host-event-failed', error)
	}
}

/**
 * Whether the pair may still get an any-host JWT. Before the cutoff every
 * pair may, and is stored as grandfathered. After it, a stored pair keeps
 * its answer; a pair not stored yet is looked up in Analytics Engine,
 * where only grandfathered pairs write `sealed` points. Throws when that
 * lookup fails, so an outage never refuses a grandfathered caller with the
 * permanent error.
 */
export async function isJwtSignAnyHostCallerGrandfathered(input: {
	env: CallerEnv
	caller: JwtSignAnyHostCaller
	now?: number
}) {
	const now = input.now ?? Date.now()
	const { ownerId, packageId } = input.caller
	const row = await input.env.APP_DB.prepare(
		`SELECT grandfathered, checked_at FROM jwt_sign_any_host_callers
		WHERE user_id = ? AND package_id = ?`,
	)
		.bind(ownerId, packageId)
		.first<{ grandfathered: number; checked_at: number }>()
	if (row?.grandfathered === 1) return true
	if (now < jwtSignNewAnyHostCallerCutoffAt) {
		// The caller's `sealed` Analytics Engine point still records the pair.
		await storeCallerDecision(input.env, input.caller, true, now).catch(
			(error: unknown) => {
				console.warn('jwt-sign-any-host-caller-store-failed', error)
			},
		)
		return true
	}
	if (row && now - row.checked_at < refusedRecheckMs) return false
	const seen = await analyticsSawAnyHostCalls(input.env, input.caller)
	if (seen === null) return false
	await storeCallerDecision(input.env, input.caller, seen, now)
	return seen
}

async function storeCallerDecision(
	env: Pick<Env, 'APP_DB'>,
	caller: JwtSignAnyHostCaller,
	grandfathered: boolean,
	now: number,
) {
	await env.APP_DB.prepare(
		`INSERT INTO jwt_sign_any_host_callers
			(user_id, package_id, grandfathered, checked_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, package_id) DO UPDATE SET
			grandfathered = MAX(jwt_sign_any_host_callers.grandfathered, excluded.grandfathered),
			checked_at = excluded.checked_at`,
	)
		.bind(caller.ownerId, caller.packageId, grandfathered ? 1 : 0, now)
		.run()
}

/** Null when Analytics Engine is not configured (local dev and tests). */
async function analyticsSawAnyHostCalls(
	env: AnalyticsEnv,
	caller: JwtSignAnyHostCaller,
) {
	if (env.WRANGLER_IS_LOCAL_DEV === 'true') return null
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return null
	if (
		!analyticsIdPattern.test(caller.ownerId) ||
		!analyticsIdPattern.test(caller.packageId)
	) {
		return false
	}
	const rows = await queryAnalyticsEngineSql<{ calls?: number | string }>({
		accountId,
		apiToken,
		baseUrl:
			env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com',
		query: `SELECT SUM(_sample_interval) AS calls
FROM ${resolveJwtSignAnyHostDataset(env)}
WHERE blob1 = '${jwtSignAnyHostEventKinds.sealed}'
	AND blob2 = '${caller.ownerId}'
	AND blob3 = '${caller.packageId}'
	AND timestamp > NOW() - INTERVAL '${grandfatherLookbackDays}' DAY`,
	})
	return Number(rows[0]?.calls ?? 0) > 0
}

/** Counts one fill of an any-host JWT on `host`. Never throws. */
export async function recordJwtSignAnyHostDestination(input: {
	env: Pick<Env, 'APP_DB'>
	caller: JwtSignAnyHostCaller
	host: string
	now?: number
}) {
	const now = input.now ?? Date.now()
	try {
		await input.env.APP_DB.prepare(
			`INSERT INTO jwt_sign_any_host_destinations
				(user_id, package_id, host, fill_count, first_filled_at, last_filled_at)
			VALUES (?, ?, ?, 1, ?, ?)
			ON CONFLICT (user_id, package_id, host) DO UPDATE SET
				fill_count = jwt_sign_any_host_destinations.fill_count + 1,
				last_filled_at = excluded.last_filled_at`,
		)
			.bind(
				input.caller.ownerId,
				input.caller.packageId,
				input.host.toLowerCase(),
				now,
				now,
			)
			.run()
	} catch (error) {
		console.warn('jwt-sign-any-host-destination-failed', error)
	}
}

/**
 * The host to fill in as `send_to_host` when every any-host JWT the pair
 * sent went to one registrable domain; null when none or several did.
 */
export async function inferJwtSignSendToHost(input: {
	env: Pick<Env, 'APP_DB'>
	caller: JwtSignAnyHostCaller
}) {
	const { results } = await input.env.APP_DB.prepare(
		`SELECT host FROM jwt_sign_any_host_destinations
		WHERE user_id = ? AND package_id = ?
		ORDER BY fill_count DESC, host`,
	)
		.bind(input.caller.ownerId, input.caller.packageId)
		.all<{ host: string }>()
	const domains = new Set(
		results.map((row) => sealedTokenDomainForUrl(`https://${row.host}`)),
	)
	if (domains.size !== 1 || domains.has(null)) return null
	return results[0]!.host
}
