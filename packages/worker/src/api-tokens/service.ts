import {
	number,
	nullable,
	object,
	parseSafe,
	string,
	type InferOutput,
} from 'remix/data-schema'
import {
	formatApiToken,
	generateApiTokenId,
	generateApiTokenSecret,
	parseApiToken,
} from '@kody-internal/shared/api-token-format.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	apiTokenScopeIncludes,
	normalizeApiTokenScopes,
	type ApiTokenScope,
} from './scopes.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const apiTokenPolicy = {
	minIdleTtlSeconds: 60,
	/** ADR 0056: idle timeout at most 14 days. */
	maxIdleTtlSeconds: 14 * 24 * 60 * 60,
	/** ADR 0056: absolute lifetime at most 3 months. */
	maxMaxLifetimeSeconds: 90 * 24 * 60 * 60,
	maxActiveTokensPerUser: 500,
	/**
	 * Profile-bound tokens (ADR 0092) are a separate pool, so a burst of
	 * sub-agent handoffs never reclaims the person's own tokens.
	 */
	maxActiveProfileTokensPerUser: 500,
	maxNameLength: 100,
	/**
	 * Sliding-expiry writes are skipped when they would extend the expiry by
	 * less than this (or a quarter of the idle TTL, whichever is smaller).
	 */
	touchDebounceSeconds: 60,
	/** Revoked or expired rows are deleted this long after they stop working. */
	inactiveRetentionSeconds: 7 * 24 * 60 * 60,
} as const

/**
 * Input aliases for required token lifetimes. Sugar only: never stored on the
 * token. `short` suits single-task agents; `long` is the policy maximum.
 */
export const apiTokenLifetimeAliases = {
	short: {
		idleTtlSeconds: 60 * 60,
		maxLifetimeSeconds: 24 * 60 * 60,
	},
	long: {
		idleTtlSeconds: apiTokenPolicy.maxIdleTtlSeconds,
		maxLifetimeSeconds: apiTokenPolicy.maxMaxLifetimeSeconds,
	},
} as const

export type ApiTokenLifetimeAlias = keyof typeof apiTokenLifetimeAliases

export const apiTokenLifetimeAliasNames = Object.keys(
	apiTokenLifetimeAliases,
) as Array<ApiTokenLifetimeAlias>

export type ResolvedApiTokenLifetime = {
	idleTtlSeconds: number
	maxLifetimeSeconds: number
	/** CLI flags that reproduce this choice (alias or explicit pair). */
	cliFlags: string
}

export function apiTokenLifetimeMissingError(surface: 'api' | 'cli') {
	if (surface === 'cli') {
		return (
			'Token lifetime is required. Pass --lifetime short|long, or both ' +
			`--idle-ttl-seconds <n> and --max-lifetime-seconds <n> ` +
			`(idle ${apiTokenPolicy.minIdleTtlSeconds}-${apiTokenPolicy.maxIdleTtlSeconds}s, ` +
			`max age up to ${apiTokenPolicy.maxMaxLifetimeSeconds}s). ` +
			'Single-task agents should use --lifetime short.'
		)
	}
	return (
		'Token lifetime is required. Pass lifetime: "short"|"long", or both ' +
		`idle_ttl_seconds and max_lifetime_seconds ` +
		`(idle ${apiTokenPolicy.minIdleTtlSeconds}-${apiTokenPolicy.maxIdleTtlSeconds}, ` +
		`max age up to ${apiTokenPolicy.maxMaxLifetimeSeconds}). ` +
		'Single-task agents should use lifetime: "short".'
	)
}

/**
 * Resolve a required lifetime choice. Aliases expand to idle/max seconds;
 * the label is not kept. Rejects missing, mixed, or over-limit values.
 */
export function resolveApiTokenLifetime(input: {
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	missingError?: string
}): ResolvedApiTokenLifetime {
	const missingError = input.missingError ?? apiTokenLifetimeMissingError('api')
	const aliasRaw =
		typeof input.lifetime === 'string' ? input.lifetime.trim() : ''
	const hasAlias = aliasRaw.length > 0
	const hasIdle = input.idleTtlSeconds !== undefined
	const hasMax = input.maxLifetimeSeconds !== undefined

	if (!hasAlias && !hasIdle && !hasMax) {
		throw new McpCallerError(missingError)
	}
	if (hasAlias && (hasIdle || hasMax)) {
		throw new McpCallerError(
			'Pass lifetime: "short"|"long", or both idle_ttl_seconds and max_lifetime_seconds, not both forms.',
		)
	}
	if (hasAlias) {
		if (!Object.hasOwn(apiTokenLifetimeAliases, aliasRaw)) {
			throw new McpCallerError(
				`lifetime must be "short" or "long" (got ${JSON.stringify(aliasRaw)}).`,
			)
		}
		const alias = aliasRaw as ApiTokenLifetimeAlias
		const resolved = apiTokenLifetimeAliases[alias]
		return {
			idleTtlSeconds: resolved.idleTtlSeconds,
			maxLifetimeSeconds: resolved.maxLifetimeSeconds,
			cliFlags: `--lifetime ${alias}`,
		}
	}
	if (!hasIdle || !hasMax) {
		throw new McpCallerError(
			'When not using lifetime: "short"|"long", both idle_ttl_seconds and max_lifetime_seconds are required.',
		)
	}
	const idleTtlSeconds = readRequiredInteger({
		value: input.idleTtlSeconds!,
		min: apiTokenPolicy.minIdleTtlSeconds,
		max: apiTokenPolicy.maxIdleTtlSeconds,
		field: 'idle_ttl_seconds',
	})
	const maxLifetimeSeconds = readRequiredInteger({
		value: input.maxLifetimeSeconds!,
		min: idleTtlSeconds,
		max: apiTokenPolicy.maxMaxLifetimeSeconds,
		field: 'max_lifetime_seconds',
	})
	return {
		idleTtlSeconds,
		maxLifetimeSeconds,
		cliFlags: `--idle-ttl-seconds ${idleTtlSeconds} --max-lifetime-seconds ${maxLifetimeSeconds}`,
	}
}

export const apiTokenCreatedVia = [
	'api',
	'mcp-api',
	'cli-bootstrap',
	'cli-login',
	'agent-registration',
] as const
export type ApiTokenCreatedVia = (typeof apiTokenCreatedVia)[number]

/** How the token picks an org on each request. */
export const apiTokenOrgBindings = ['org', 'user'] as const
export type ApiTokenOrgBinding = (typeof apiTokenOrgBindings)[number]

const apiTokenRowSchema = object({
	id: string(),
	user_id: string(),
	org_id: string(),
	name: string(),
	token_hash: string(),
	scopes_json: string(),
	idle_ttl_seconds: number(),
	expires_at: string(),
	max_expires_at: string(),
	created_via: string(),
	created_at: string(),
	updated_at: string(),
	last_used_at: nullable(string()),
	rotated_at: nullable(string()),
	revoked_at: nullable(string()),
	profile_name: nullable(string()),
	profile_id: nullable(string()),
})

type ApiTokenRow = InferOutput<typeof apiTokenRowSchema>

export type ApiTokenRecord = Omit<ApiTokenRow, 'scopes_json'> & {
	scopes: Array<ApiTokenScope>
	/**
	 * `org`: fixed to `org_id` (legacy / explicit). `user`: person-owned; each
	 * request picks an org via `?org=` (default personal).
	 */
	org_binding: ApiTokenOrgBinding
}

export type ApiTokenStatus = 'active' | 'expired' | 'revoked'

/** Public token metadata. Never includes the plaintext or its hash. */
export type ApiTokenView = {
	id: string
	name: string
	org_id: string
	org_binding: ApiTokenOrgBinding
	scopes: Array<ApiTokenScope>
	status: ApiTokenStatus
	idle_ttl_seconds: number
	expires_at: string
	max_expires_at: string
	created_via: string
	created_at: string
	last_used_at: string | null
	rotated_at: string | null
	revoked_at: string | null
	profile_name: string | null
	/** Profile (ADR 0092) this token acts as; null is the live mirror. */
	profile_id: string | null
}

export type ApiTokenSecretView = ApiTokenView & {
	/** Shown once. Store it; Kody keeps only a hash. */
	token: string
	token_type: 'Bearer'
}

function readOrgBinding(value: unknown): ApiTokenOrgBinding {
	if (value === 'user') return 'user'
	return 'org'
}

function mapRow(row: Record<string, unknown>): ApiTokenRecord {
	// org_id is required. A missing value must not be coerced to user_id.
	if (typeof row.org_id !== 'string' || !row.org_id.trim()) {
		throw new Error('Invalid API token record: org_id is required')
	}
	const parsed = parseSafe(apiTokenRowSchema, {
		...row,
		profile_name:
			typeof row.profile_name === 'string' || row.profile_name === null
				? row.profile_name
				: null,
		profile_id: typeof row.profile_id === 'string' ? row.profile_id : null,
	})
	if (!parsed.success) {
		const message = parsed.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid API token record: ${message}`)
	}
	const { scopes_json, ...rest } = parsed.value
	return {
		...rest,
		org_binding: readOrgBinding(row.org_binding),
		scopes: normalizeApiTokenScopes(JSON.parse(scopes_json) as Array<unknown>),
	}
}

export function getApiTokenStatus(
	record: ApiTokenRecord,
	now: Date = new Date(),
): ApiTokenStatus {
	if (record.revoked_at) return 'revoked'
	return Date.parse(record.expires_at) > now.getTime() ? 'active' : 'expired'
}

export function toApiTokenView(
	record: ApiTokenRecord,
	now: Date = new Date(),
): ApiTokenView {
	return {
		id: record.id,
		name: record.name,
		org_id: record.org_id,
		org_binding: record.org_binding,
		scopes: record.scopes,
		status: getApiTokenStatus(record, now),
		idle_ttl_seconds: record.idle_ttl_seconds,
		expires_at: record.expires_at,
		max_expires_at: record.max_expires_at,
		created_via: record.created_via,
		created_at: record.created_at,
		last_used_at: record.last_used_at,
		rotated_at: record.rotated_at,
		revoked_at: record.revoked_at,
		profile_name: record.profile_name ?? null,
		profile_id: record.profile_id ?? null,
	}
}

function addSeconds(date: Date, seconds: number) {
	return new Date(date.getTime() + seconds * 1000)
}

function slidingExpiry(input: {
	now: Date
	idleTtlSeconds: number
	maxExpiresAt: string
}) {
	const idleExpiry = addSeconds(input.now, input.idleTtlSeconds).getTime()
	return new Date(
		Math.min(idleExpiry, Date.parse(input.maxExpiresAt)),
	).toISOString()
}

function readRequiredInteger(input: {
	value: number
	min: number
	max: number
	field: string
}) {
	if (
		!Number.isInteger(input.value) ||
		input.value < input.min ||
		input.value > input.max
	) {
		throw new McpCallerError(
			`${input.field} must be an integer between ${input.min} and ${input.max}.`,
		)
	}
	return input.value
}

function readTokenName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) throw new McpCallerError('Token name is required.')
	if (trimmed.length > apiTokenPolicy.maxNameLength) {
		throw new McpCallerError(
			`Token name must be at most ${apiTokenPolicy.maxNameLength} characters.`,
		)
	}
	return trimmed
}

async function hashSecret(secret: string) {
	return sha256Hex(secret)
}

async function pruneInactiveApiTokens(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	const cutoff = addSeconds(
		input.now,
		-apiTokenPolicy.inactiveRetentionSeconds,
	).toISOString()
	await input.db
		.prepare(
			`DELETE FROM api_tokens
			WHERE user_id = ?
				AND (revoked_at < ? OR expires_at < ?)${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, cutoff, cutoff)
		.run()
}

type ApiTokenPool = 'person' | 'profile'

function apiTokenPoolSql(pool: ApiTokenPool) {
	return pool === 'profile'
		? ' AND profile_id IS NOT NULL'
		: ' AND profile_id IS NULL'
}

function apiTokenPoolCap(pool: ApiTokenPool) {
	return pool === 'profile'
		? apiTokenPolicy.maxActiveProfileTokensPerUser
		: apiTokenPolicy.maxActiveTokensPerUser
}

async function countActiveApiTokens(input: {
	db: D1Database
	userId: string
	now: Date
	pool: ApiTokenPool
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM api_tokens
			WHERE user_id = ?
				AND revoked_at IS NULL
				AND expires_at > ?${apiTokenPoolSql(input.pool)}${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.now.toISOString())
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * Remaining life until the token stops working: time until the stored
 * `expires_at` (already the sooner of the sliding idle window and
 * `max_expires_at`). Prefer `expires_at` over recomputing from
 * last_used_at/created_at so rotation and touch stay accurate for reclaim.
 */
export function apiTokenRemainingLifeMs(
	record: Pick<ApiTokenRecord, 'expires_at'>,
	now: Date,
) {
	return Date.parse(record.expires_at) - now.getTime()
}

async function listActiveApiTokenRecords(input: {
	db: D1Database
	userId: string
	now: Date
	pool: ApiTokenPool
}) {
	const rows = await input.db
		.prepare(
			`SELECT *
			FROM api_tokens
			WHERE user_id = ?
				AND revoked_at IS NULL
				AND expires_at > ?${apiTokenPoolSql(input.pool)}${andLiveDeletedAtSql()}
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(input.userId, input.now.toISOString())
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapRow)
}

/**
 * When the account is at or over the active-token cap, revoke active tokens
 * with the least remaining life until `activeCount + slotsNeeded <= max`.
 * Never revokes ids in `excludeTokenIds` (caller + just-minted). Optionally
 * only considers tokens created strictly before `onlyCreatedBefore` so a
 * concurrent sibling mint is not revoked by post-insert healing. Applies to
 * every mint via `mintApiToken`.
 */
async function reclaimApiTokenSlots(input: {
	db: D1Database
	userId: string
	now: Date
	pool: ApiTokenPool
	excludeTokenIds?: ReadonlyArray<string>
	/** ISO timestamp: only reclaim rows with created_at strictly earlier. */
	onlyCreatedBefore?: string
	slotsNeeded: number
}) {
	const excluded = new Set(
		(input.excludeTokenIds ?? []).filter((id) => typeof id === 'string' && id),
	)
	let activeCount = await countActiveApiTokens(input)
	const cap = apiTokenPoolCap(input.pool)
	while (activeCount + input.slotsNeeded > cap) {
		const active = await listActiveApiTokenRecords(input)
		const candidates = active
			.filter((record) => {
				if (excluded.has(record.id)) return false
				if (
					input.onlyCreatedBefore &&
					!(record.created_at < input.onlyCreatedBefore)
				) {
					return false
				}
				return true
			})
			.sort((left, right) => {
				const lifeDiff =
					apiTokenRemainingLifeMs(left, input.now) -
					apiTokenRemainingLifeMs(right, input.now)
				if (lifeDiff !== 0) return lifeDiff
				return left.id.localeCompare(right.id)
			})
		const victim = candidates[0]
		if (!victim) {
			// Soft overshoot from concurrent sibling mints; next mint heals.
			if (input.onlyCreatedBefore && input.slotsNeeded === 0) return
			throw new McpCallerError(
				input.pool === 'profile'
					? `This account already has ${cap} active profile tokens and none can be reclaimed (protected tokens cannot be revoked). Revoke one before minting another.`
					: `This account already has ${cap} active API tokens and none can be reclaimed (protected tokens cannot be revoked). Revoke one before minting another.`,
			)
		}
		await revokeApiToken({
			db: input.db,
			userId: input.userId,
			tokenId: victim.id,
			now: input.now,
		})
		activeCount = await countActiveApiTokens(input)
	}
}

/**
 * The token doing the minting, when a token mints a token. A child token can
 * never hold scopes the parent lacks or outlive the parent's absolute expiry.
 * A profile-bound parent can only mint tokens for the same profile.
 */
export type ApiTokenMintParent = {
	scopes: ReadonlyArray<ApiTokenScope>
	maxExpiresAt: string
	profileName?: string | null
	/** Profile the parent acts as; a child must stay on a profile too. */
	profileId?: string | null
}

export async function mintApiToken(input: {
	db: D1Database
	userId: string
	/**
	 * Org this token is bound to when `orgBinding` is `org`. Defaults to the
	 * caller's personal org (`userId`). Ignored for auth when `orgBinding` is
	 * `user` (still stored as the personal org for NOT NULL / display).
	 */
	orgId?: string
	/**
	 * `org` (default): fixed org from `orgId`. `user`: person-owned; each
	 * request selects an org via `?org=` (default personal).
	 */
	orgBinding?: ApiTokenOrgBinding
	name: string
	scopes: ReadonlyArray<unknown>
	idleTtlSeconds: number
	maxLifetimeSeconds: number
	createdVia: ApiTokenCreatedVia
	parent?: ApiTokenMintParent
	profileName?: string | null
	/**
	 * Profile (ADR 0092) the token acts as. The caller has already checked the
	 * minter may act for it (`resolveProfileTokenTarget`).
	 */
	profileId?: string | null
	/** Earliest expiry across the profile chain; the token never outlives it. */
	profileMaxExpiresAt?: string | null
	/** Never reclaimed when the active-token pool is full. */
	excludeTokenId?: string
	now?: Date
}): Promise<ApiTokenSecretView> {
	const now = input.now ?? new Date()
	const name = readTokenName(input.name)
	const orgBinding: ApiTokenOrgBinding =
		input.orgBinding === 'user' ? 'user' : 'org'
	const orgId =
		orgBinding === 'user' ? input.userId : input.orgId?.trim() || input.userId
	let scopes: Array<ApiTokenScope>
	try {
		scopes = normalizeApiTokenScopes(input.scopes)
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : String(error),
		)
	}
	if (scopes.length === 0) {
		throw new McpCallerError('At least one scope is required.')
	}
	const parent = input.parent
	if (parent) {
		const missing = scopes.filter(
			(scope) => !apiTokenScopeIncludes(parent.scopes, scope),
		)
		if (missing.length > 0) {
			throw new McpCallerError(
				`A token cannot grant scopes it does not hold: ${missing.join(', ')}.`,
			)
		}
	}
	const profileName =
		typeof input.profileName === 'string' && input.profileName.trim()
			? input.profileName.trim()
			: null
	if (parent?.profileName) {
		if (!profileName || profileName !== parent.profileName) {
			throw new McpCallerError(
				`A profile-bound token can only mint tokens for the same connection profile ("${parent.profileName}").`,
			)
		}
	}
	const profileId = input.profileId?.trim() || null
	if (profileId && profileName) {
		throw new McpCallerError(
			'A token binds to a profile or a connection profile, not both.',
		)
	}
	if (parent?.profileId && !profileId) {
		throw new McpCallerError(
			'A profile-bound token can only mint tokens for itself or its sub-profiles.',
		)
	}
	if (profileId && orgBinding !== 'org') {
		throw new McpCallerError(
			'A profile token is bound to the profile\'s org; org_binding must be "org".',
		)
	}
	const idleTtlSeconds = readRequiredInteger({
		value: input.idleTtlSeconds,
		min: apiTokenPolicy.minIdleTtlSeconds,
		max: apiTokenPolicy.maxIdleTtlSeconds,
		field: 'idle_ttl_seconds',
	})
	const maxLifetimeSeconds = readRequiredInteger({
		value: input.maxLifetimeSeconds,
		min: idleTtlSeconds,
		max: apiTokenPolicy.maxMaxLifetimeSeconds,
		field: 'max_lifetime_seconds',
	})
	let maxExpiresAtMs = addSeconds(now, maxLifetimeSeconds).getTime()
	if (parent) {
		maxExpiresAtMs = Math.min(maxExpiresAtMs, Date.parse(parent.maxExpiresAt))
	}
	if (profileId && input.profileMaxExpiresAt) {
		maxExpiresAtMs = Math.min(
			maxExpiresAtMs,
			Date.parse(input.profileMaxExpiresAt),
		)
	}
	if (maxExpiresAtMs <= now.getTime()) {
		throw new McpCallerError(
			'The resulting API token would already be expired (absolute max expiry is not in the future).',
		)
	}
	const maxExpiresAt = new Date(maxExpiresAtMs).toISOString()

	await pruneInactiveApiTokens({ db: input.db, userId: input.userId, now })
	const protectedIds = input.excludeTokenId ? [input.excludeTokenId] : []
	const pool: ApiTokenPool = profileId ? 'profile' : 'person'
	await reclaimApiTokenSlots({
		db: input.db,
		userId: input.userId,
		now,
		pool,
		excludeTokenIds: protectedIds,
		slotsNeeded: 1,
	})
	const tokenId = generateApiTokenId()
	const secret = generateApiTokenSecret()
	const nowIso = now.toISOString()
	const record: ApiTokenRecord = {
		id: tokenId,
		user_id: input.userId,
		org_id: orgId,
		org_binding: orgBinding,
		name,
		token_hash: await hashSecret(secret),
		scopes,
		idle_ttl_seconds: idleTtlSeconds,
		expires_at: slidingExpiry({ now, idleTtlSeconds, maxExpiresAt }),
		max_expires_at: maxExpiresAt,
		created_via: input.createdVia,
		created_at: nowIso,
		updated_at: nowIso,
		last_used_at: null,
		rotated_at: null,
		revoked_at: null,
		profile_name: profileName,
		profile_id: profileId,
	}
	await input.db
		.prepare(
			`INSERT INTO api_tokens (
				id,
				user_id,
				org_id,
				org_binding,
				name,
				token_hash,
				scopes_json,
				idle_ttl_seconds,
				expires_at,
				max_expires_at,
				created_via,
				created_at,
				updated_at,
				profile_name,
				profile_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.user_id,
			record.org_id,
			record.org_binding,
			record.name,
			record.token_hash,
			JSON.stringify(record.scopes),
			record.idle_ttl_seconds,
			record.expires_at,
			record.max_expires_at,
			record.created_via,
			record.created_at,
			record.updated_at,
			record.profile_name,
			record.profile_id,
		)
		.run()
	// Heal concurrent mint races that both reclaimed the same victim. Only
	// reclaim older rows so a sibling mint created in the same race is kept.
	await reclaimApiTokenSlots({
		db: input.db,
		userId: input.userId,
		now,
		pool,
		excludeTokenIds: [...protectedIds, record.id],
		onlyCreatedBefore: record.created_at,
		slotsNeeded: 0,
	})
	return {
		...toApiTokenView(record, now),
		token: formatApiToken({ tokenId, secret }),
		token_type: 'Bearer',
	}
}

export async function getApiTokenRecord(input: {
	db: D1Database
	userId: string
	tokenId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT * FROM api_tokens WHERE id = ? AND user_id = ? ${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.tokenId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

export async function listApiTokens(input: {
	db: D1Database
	userId: string
	includeInactive?: boolean
	now?: Date
}) {
	const now = input.now ?? new Date()
	const rows = await input.db
		.prepare(
			`SELECT *
			FROM api_tokens
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY created_at DESC, id ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? [])
		.map(mapRow)
		.filter(
			(record) =>
				input.includeInactive || getApiTokenStatus(record, now) === 'active',
		)
		.map((record) => toApiTokenView(record, now))
}

export async function revokeApiToken(input: {
	db: D1Database
	userId: string
	tokenId: string
	now?: Date
}) {
	const nowIso = (input.now ?? new Date()).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE api_tokens
			SET revoked_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ? AND revoked_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(nowIso, nowIso, input.tokenId, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Replace the secret of an active token. The previous plaintext stops
 * working immediately; scopes and the absolute expiry are unchanged.
 */
export async function rotateApiToken(input: {
	db: D1Database
	userId: string
	tokenId: string
	now?: Date
}): Promise<ApiTokenSecretView | null> {
	const now = input.now ?? new Date()
	const record = await getApiTokenRecord(input)
	if (!record || getApiTokenStatus(record, now) !== 'active') return null
	const secret = generateApiTokenSecret()
	const nowIso = now.toISOString()
	const rotated: ApiTokenRecord = {
		...record,
		token_hash: await hashSecret(secret),
		expires_at: slidingExpiry({
			now,
			idleTtlSeconds: record.idle_ttl_seconds,
			maxExpiresAt: record.max_expires_at,
		}),
		rotated_at: nowIso,
		updated_at: nowIso,
	}
	const result = await input.db
		.prepare(
			`UPDATE api_tokens
			SET token_hash = ?, expires_at = ?, rotated_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ? AND token_hash = ? AND revoked_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(
			rotated.token_hash,
			rotated.expires_at,
			rotated.rotated_at,
			rotated.updated_at,
			record.id,
			record.user_id,
			record.token_hash,
		)
		.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return {
		...toApiTokenView(rotated, now),
		token: formatApiToken({ tokenId: record.id, secret }),
		token_type: 'Bearer',
	}
}

export type ApiTokenAuthenticationFailure =
	| 'malformed'
	| 'unknown'
	| 'revoked'
	| 'expired'

export type ApiTokenAuthentication =
	| { ok: true; record: ApiTokenRecord }
	| {
			ok: false
			reason: ApiTokenAuthenticationFailure
			/** Present when the token id resolved to a stored row. */
			record?: ApiTokenRecord
	  }

export async function authenticateApiToken(input: {
	db: D1Database
	token: string
	now?: Date
}): Promise<ApiTokenAuthentication> {
	const parsed = parseApiToken(input.token)
	if (!parsed) return { ok: false, reason: 'malformed' }
	const row = await input.db
		.prepare(
			`SELECT * FROM api_tokens WHERE id = ? ${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(parsed.tokenId)
		.first<Record<string, unknown>>()
	if (!row) return { ok: false, reason: 'unknown' }
	const record = mapRow(row)
	const hashMatches = await timingSafeEqualString(
		await hashSecret(parsed.secret),
		record.token_hash,
	)
	// Wrong secret must not expose the owner record: CapabilityProxy observe-only
	// metering uses `record.user_id` as meteringUserId, and attributing a guess
	// to the owner corrupts their api_call error metrics.
	if (!hashMatches) return { ok: false, reason: 'unknown' }
	const status = getApiTokenStatus(record, input.now)
	switch (status) {
		case 'active':
			return { ok: true, record }
		case 'revoked':
			return { ok: false, reason: 'revoked', record }
		case 'expired':
			return { ok: false, reason: 'expired', record }
		default: {
			const exhaustive: never = status
			throw new Error(`Unexpected API token status: ${String(exhaustive)}`)
		}
	}
}

/**
 * The token as it stands after a successful request at `now`: `expires_at`
 * slid forward by the idle TTL, capped at the absolute expiry. After the first
 * use, returns `null` when the extension is smaller than the debounce window, so hot tokens do
 * not write D1 on every call. The window is at most a quarter of the idle
 * TTL, so a token in use always keeps at least three quarters of it.
 */
export function slideApiTokenExpiry(
	record: ApiTokenRecord,
	now: Date = new Date(),
): ApiTokenRecord | null {
	const expiresAt = slidingExpiry({
		now,
		idleTtlSeconds: record.idle_ttl_seconds,
		maxExpiresAt: record.max_expires_at,
	})
	const debounceMs =
		Math.min(apiTokenPolicy.touchDebounceSeconds, record.idle_ttl_seconds / 4) *
		1000
	if (
		record.last_used_at !== null &&
		Date.parse(expiresAt) - Date.parse(record.expires_at) < debounceMs
	) {
		return null
	}
	return { ...record, expires_at: expiresAt, last_used_at: now.toISOString() }
}

/** Persist a record returned by `slideApiTokenExpiry`. */
export async function touchApiToken(input: {
	db: D1Database
	record: ApiTokenRecord
}) {
	const usedAt = input.record.last_used_at ?? new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE api_tokens
			SET expires_at = ?, last_used_at = ?
			WHERE id = ? AND revoked_at IS NULL AND expires_at > ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.record.expires_at, usedAt, input.record.id, usedAt)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** When a token was issued, for password-change lockout. */
export function getApiTokenIssuedAtMs(record: ApiTokenRecord) {
	return Date.parse(record.rotated_at ?? record.created_at)
}

export function apiTokenIdleTtlDescription() {
	return (
		`Tokens require an explicit lifetime: lifetime "short" ` +
		`(${apiTokenLifetimeAliases.short.idleTtlSeconds}s idle / ` +
		`${apiTokenLifetimeAliases.short.maxLifetimeSeconds}s max) or "long" ` +
		`(${apiTokenLifetimeAliases.long.idleTtlSeconds}s idle / ` +
		`${apiTokenLifetimeAliases.long.maxLifetimeSeconds}s max), or both ` +
		`idle_ttl_seconds (${apiTokenPolicy.minIdleTtlSeconds}-` +
		`${apiTokenPolicy.maxIdleTtlSeconds}) and max_lifetime_seconds ` +
		`(up to ${apiTokenPolicy.maxMaxLifetimeSeconds}). Each successful ` +
		`request slides expires_at forward, never past max_expires_at. ` +
		`At most ${apiTokenPolicy.maxActiveTokensPerUser} active tokens per ` +
		`account; a new mint reclaims the active token(s) with the least ` +
		`remaining life (sooner of idle deadline and absolute expiry), never ` +
		`the caller's own token.`
	)
}
