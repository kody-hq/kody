import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { localExecuteOrgPermissions } from './legacy-scope-rewrite.ts'
import {
	apiTokenScopeIncludes,
	normalizeApiTokenScopes,
	type ApiTokenScope,
} from './scopes.ts'
import {
	apiTokenLifetimeMissingError,
	apiTokenPolicy,
	mintApiToken,
	resolveApiTokenLifetime,
	type ApiTokenMintParent,
	type ApiTokenOrgBinding,
	type ApiTokenSecretView,
	type ResolvedApiTokenLifetime,
} from './service.ts'

/**
 * Bootstrap defaults = local-execute parity + `org:read` (account reads) +
 * plain-repo push (`package:write`) + stub package create via
 * `packageGetGitRemote` (`package:create`) + self-revoke (`token:delete`).
 */
export const cliCredentialBootstrapDefaultScopes = normalizeApiTokenScopes([
	...localExecuteOrgPermissions,
	'org:read',
	'package:write',
	'package:create',
	'token:delete',
]) as Array<ApiTokenScope>

/** Distinct from `kody_at_` so chat/logs can show the CLI command safely. */
export const cliBootstrapCodePrefix = 'kody_bc_'

const bootstrapCodeIdLength = 16
const bootstrapCodeSecretBytes = 24
const bootstrapCodeIdAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const cliCredentialBootstrapPolicy = {
	/** Absolute redeem deadline (not sliding). */
	defaultRedeemTtlSeconds: 10 * 60,
	minRedeemTtlSeconds: 60,
	maxRedeemTtlSeconds: 15 * 60,
	maxOutstandingCodesPerUser: 5,
	defaultName: 'kody-cli-bootstrap',
	/**
	 * Pre-P4 `local-execute` + `account:read` parity under org permissions:
	 * CapabilityProxy hops (`org:execute`), account reads (`org:read`), and
	 * the use-level scopes saved packages need (package-graph
	 * `package:execute`, `createAuthenticatedFetch` → `integration:read`,
	 * secrets, email, jobs, …), plus `package:write` (plain-repo / package
	 * pushes), `package:create` (`packageGetGitRemote` create stubs), and
	 * `token:delete` (self-revoke). Do not mint `search:read`.
	 */
	defaultScopes: cliCredentialBootstrapDefaultScopes,
	minIdleTtlSeconds: apiTokenPolicy.minIdleTtlSeconds,
	maxIdleTtlSeconds: apiTokenPolicy.maxIdleTtlSeconds,
	maxMaxLifetimeSeconds: apiTokenPolicy.maxMaxLifetimeSeconds,
	cliCommand: (code: string, lifetimeCliFlags: string) =>
		`npx @kodycodes/cli auth bootstrap --code ${code} ${lifetimeCliFlags}`,
} as const

const bootstrapCodePattern = /^kody_bc_([a-z0-9]{16})_([A-Za-z0-9_-]{32})$/

export type ParsedCliBootstrapCode = {
	codeId: string
	secret: string
}

export type CliCredentialBootstrapView = {
	bootstrap_code: string
	expires_at: string
	cli_command: string
	name: string
	scopes: Array<ApiTokenScope>
	idle_ttl_seconds: number
	max_lifetime_seconds: number
}

function generateBootstrapCodeId() {
	const bytes = crypto.getRandomValues(new Uint8Array(bootstrapCodeIdLength))
	let id = ''
	for (const byte of bytes) {
		id += bootstrapCodeIdAlphabet[byte % bootstrapCodeIdAlphabet.length]
	}
	return id
}

function generateBootstrapCodeSecret() {
	return bytesToBase64Url(
		crypto.getRandomValues(new Uint8Array(bootstrapCodeSecretBytes)),
	)
}

export function formatCliBootstrapCode(input: ParsedCliBootstrapCode) {
	return `${cliBootstrapCodePrefix}${input.codeId}_${input.secret}`
}

export function parseCliBootstrapCode(
	value: string,
): ParsedCliBootstrapCode | null {
	const match = bootstrapCodePattern.exec(value.trim())
	if (!match) return null
	const [, codeId, secret] = match
	if (!codeId || !secret) return null
	return { codeId, secret }
}

async function hashBootstrapCode(code: string) {
	return sha256Hex(code.trim())
}

function readTokenName(name: string) {
	const trimmed = name.trim()
	if (trimmed.length === 0) {
		throw new McpCallerError('Token name must not be empty.')
	}
	if (trimmed.length > apiTokenPolicy.maxNameLength) {
		throw new McpCallerError(
			`Token name must be at most ${apiTokenPolicy.maxNameLength} characters.`,
		)
	}
	return trimmed
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

async function countOutstandingBootstrapCodes(input: {
	db: D1Database
	userId: OwnerId
	now: Date
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM cli_credential_bootstrap_codes
			 WHERE user_id = ?
			   AND consumed_at IS NULL
			   AND expires_at > ?`,
		)
		.bind(input.userId, input.now.toISOString())
		.first<{ count: number }>()
	return row?.count ?? 0
}

async function pruneExpiredBootstrapCodes(input: {
	db: D1Database
	userId: OwnerId
	now: Date
}) {
	await input.db
		.prepare(
			`DELETE FROM cli_credential_bootstrap_codes
			 WHERE user_id = ?
			   AND (
			     (consumed_at IS NOT NULL AND consumed_at < ?)
			     OR (consumed_at IS NULL AND expires_at < ?)
			   )`,
		)
		.bind(
			input.userId,
			new Date(
				input.now.getTime() - apiTokenPolicy.inactiveRetentionSeconds * 1000,
			).toISOString(),
			input.now.toISOString(),
		)
		.run()
		.catch(() => undefined)
}

function resolveBootstrapLifetime(input: {
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	parentRemainingSeconds: number | null
}): ResolvedApiTokenLifetime {
	const resolved = resolveApiTokenLifetime({
		lifetime: input.lifetime,
		idleTtlSeconds: input.idleTtlSeconds,
		maxLifetimeSeconds: input.maxLifetimeSeconds,
		missingError: apiTokenLifetimeMissingError('api'),
	})
	if (input.parentRemainingSeconds === null) return resolved
	if (input.parentRemainingSeconds < resolved.idleTtlSeconds) {
		throw new McpCallerError(
			'The calling API token expires too soon to mint a CLI bootstrap code.',
		)
	}
	const maxLifetimeSeconds = Math.min(
		resolved.maxLifetimeSeconds,
		input.parentRemainingSeconds,
	)
	if (maxLifetimeSeconds === resolved.maxLifetimeSeconds) return resolved
	return {
		...resolved,
		maxLifetimeSeconds,
		cliFlags: `--idle-ttl-seconds ${resolved.idleTtlSeconds} --max-lifetime-seconds ${maxLifetimeSeconds}`,
	}
}

/**
 * Mint a one-shot bootstrap code for the CLI. Does **not** return a
 * `kody_at_` — the CLI redeems the code over HTTPS.
 */
export async function mintCliCredentialBootstrap(input: {
	db: D1Database
	userId: OwnerId
	/**
	 * Stored for org-bound codes only. New CLI bootstraps default to
	 * user-owned tokens (`orgBinding: 'user'`); `orgId` is kept as the
	 * personal org placeholder on the code row.
	 */
	orgId?: string
	/**
	 * Defaults to `user` so new CLI credentials cover every org the person
	 * can access (selected per request with `?org=`). Pass `org` only when
	 * deliberately minting a legacy org-bound token.
	 */
	orgBinding?: ApiTokenOrgBinding
	name?: string
	scopes?: ReadonlyArray<unknown>
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	redeemTtlSeconds?: number
	parent?: ApiTokenMintParent
	now?: Date
}): Promise<CliCredentialBootstrapView> {
	const now = input.now ?? new Date()
	const name = readTokenName(
		input.name ?? cliCredentialBootstrapPolicy.defaultName,
	)
	const parent = input.parent
	const requestedScopesExplicitly = input.scopes !== undefined
	let scopes: Array<ApiTokenScope>
	try {
		const requested = normalizeApiTokenScopes(
			input.scopes ?? [...cliCredentialBootstrapPolicy.defaultScopes],
		)
		// API-token parents that omit `scopes` get the intersection of defaults
		// and what they hold. Otherwise adding `package:execute` to defaults
		// would break package-free bootstrap from older org:execute+org:read
		// parents. Explicit `scopes` still escalate-check against the parent.
		// MCP / session callers (no parent) keep the full default set.
		scopes =
			parent && !requestedScopesExplicitly
				? requested.filter((scope) =>
						apiTokenScopeIncludes(parent.scopes, scope),
					)
				: requested
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : String(error),
		)
	}
	if (scopes.length === 0) {
		throw new McpCallerError('At least one scope is required.')
	}
	if (
		parent &&
		!requestedScopesExplicitly &&
		!apiTokenScopeIncludes(scopes, 'org:execute')
	) {
		throw new McpCallerError(
			'A token cannot mint a CLI bootstrap code without holding org:execute.',
		)
	}
	if (parent && requestedScopesExplicitly) {
		const missing = scopes.filter(
			(scope) => !apiTokenScopeIncludes(parent.scopes, scope),
		)
		if (missing.length > 0) {
			throw new McpCallerError(
				`A token cannot grant scopes it does not hold: ${missing.join(', ')}.`,
			)
		}
	}

	const parentRemainingSeconds = parent
		? Math.floor((Date.parse(parent.maxExpiresAt) - now.getTime()) / 1000)
		: null
	if (
		parentRemainingSeconds !== null &&
		parentRemainingSeconds < cliCredentialBootstrapPolicy.minIdleTtlSeconds
	) {
		throw new McpCallerError(
			'The calling API token expires too soon to mint a CLI bootstrap code.',
		)
	}

	const lifetime = resolveBootstrapLifetime({
		lifetime: input.lifetime,
		idleTtlSeconds: input.idleTtlSeconds,
		maxLifetimeSeconds: input.maxLifetimeSeconds,
		parentRemainingSeconds,
	})
	const redeemTtlSeconds = readRequiredInteger({
		value:
			input.redeemTtlSeconds ??
			cliCredentialBootstrapPolicy.defaultRedeemTtlSeconds,
		min: cliCredentialBootstrapPolicy.minRedeemTtlSeconds,
		max: cliCredentialBootstrapPolicy.maxRedeemTtlSeconds,
		field: 'redeem_ttl_seconds',
	})

	await pruneExpiredBootstrapCodes({
		db: input.db,
		userId: input.userId,
		now,
	})
	const outstanding = await countOutstandingBootstrapCodes({
		db: input.db,
		userId: input.userId,
		now,
	})
	if (outstanding >= cliCredentialBootstrapPolicy.maxOutstandingCodesPerUser) {
		throw new McpCallerError(
			`This account already has ${cliCredentialBootstrapPolicy.maxOutstandingCodesPerUser} outstanding CLI bootstrap codes. Redeem or wait for expiry before minting another.`,
		)
	}

	const codeId = generateBootstrapCodeId()
	const secret = generateBootstrapCodeSecret()
	const bootstrapCode = formatCliBootstrapCode({ codeId, secret })
	const codeHash = await hashBootstrapCode(bootstrapCode)
	const nowIso = now.toISOString()
	const expiresAt = new Date(
		now.getTime() + redeemTtlSeconds * 1000,
	).toISOString()

	const orgBinding: ApiTokenOrgBinding =
		input.orgBinding === 'org' ? 'org' : 'user'
	const orgId =
		orgBinding === 'user' ? input.userId : input.orgId?.trim() || input.userId
	await input.db
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (
				id, user_id, org_id, org_binding, code_hash, name, scopes_json,
				idle_ttl_seconds, max_lifetime_seconds, expires_at, created_at, consumed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			codeId,
			input.userId,
			orgId,
			orgBinding,
			codeHash,
			name,
			JSON.stringify(scopes),
			lifetime.idleTtlSeconds,
			lifetime.maxLifetimeSeconds,
			expiresAt,
			nowIso,
		)
		.run()

	return {
		bootstrap_code: bootstrapCode,
		expires_at: expiresAt,
		cli_command: cliCredentialBootstrapPolicy.cliCommand(
			bootstrapCode,
			lifetime.cliFlags,
		),
		name,
		scopes,
		idle_ttl_seconds: lifetime.idleTtlSeconds,
		max_lifetime_seconds: lifetime.maxLifetimeSeconds,
	}
}

/** Stored bootstrap codes must name an org. Do not fall back to user_id. */
function requireBootstrapOrgId(orgId: unknown): string {
	const trimmed = typeof orgId === 'string' ? orgId.trim() : ''
	if (!trimmed) {
		throw new McpCallerError('CLI bootstrap code is missing an org binding.')
	}
	return trimmed
}

/**
 * Exchange a one-shot bootstrap code for a normal `kody_at_` API token.
 * Burns the code atomically before minting. Lifetime is chosen at redeem time
 * but cannot exceed the idle/max authorized when the code was minted (parent
 * clamps and the caller's choice at mint). Pass `env` on the HTTP path so
 * reclaim+mint run under the account write lease.
 */
export async function redeemCliCredentialBootstrap(input: {
	db: D1Database
	code: string
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	env?: UserMeterEnv
	now?: Date
}): Promise<{ token: ApiTokenSecretView; userId: OwnerId }> {
	const now = input.now ?? new Date()
	const parsed = parseCliBootstrapCode(input.code)
	if (!parsed) {
		throw new McpCallerError('Invalid CLI bootstrap code.')
	}
	const requested = resolveApiTokenLifetime({
		lifetime: input.lifetime,
		idleTtlSeconds: input.idleTtlSeconds,
		maxLifetimeSeconds: input.maxLifetimeSeconds,
		missingError: apiTokenLifetimeMissingError('cli'),
	})
	const codeHash = await hashBootstrapCode(input.code.trim())
	const row = await input.db
		.prepare(
			`SELECT id, user_id, org_id, org_binding, code_hash, name, scopes_json,
			        idle_ttl_seconds, max_lifetime_seconds, expires_at, created_at, consumed_at
			 FROM cli_credential_bootstrap_codes
			 WHERE id = ?`,
		)
		.bind(parsed.codeId)
		.first<{
			id: string
			user_id: OwnerId
			org_id: string
			org_binding: string | null
			code_hash: string
			name: string
			scopes_json: string
			idle_ttl_seconds: number
			max_lifetime_seconds: number
			expires_at: string
			created_at: string
			consumed_at: string | null
		}>()

	if (!row || !timingSafeEqualString(row.code_hash, codeHash)) {
		throw new McpCallerError('Invalid CLI bootstrap code.')
	}
	if (row.consumed_at) {
		throw new McpCallerError('CLI bootstrap code was already redeemed.')
	}
	if (Date.parse(row.expires_at) <= now.getTime()) {
		throw new McpCallerError('CLI bootstrap code expired.')
	}
	if (
		requested.idleTtlSeconds > row.idle_ttl_seconds ||
		requested.maxLifetimeSeconds > row.max_lifetime_seconds
	) {
		throw new McpCallerError(
			`Redeem lifetime cannot exceed the bootstrap code's authorized idle_ttl_seconds (${row.idle_ttl_seconds}) and max_lifetime_seconds (${row.max_lifetime_seconds}). Call cliCredentialBootstrap again with a longer lifetime if needed.`,
		)
	}
	// Absolute expiry is anchored to code created_at + authorized max. Reject
	// before burning when that window has already ended so a late redeem does
	// not consume the code and hand back an already-expired token.
	const authorizedMaxExpiresAtMs =
		Date.parse(row.created_at) + row.max_lifetime_seconds * 1000
	if (authorizedMaxExpiresAtMs <= now.getTime()) {
		throw new McpCallerError(
			`The bootstrap code's authorized token lifetime window has already ended. Call cliCredentialBootstrap again.`,
		)
	}
	// Reject before burning so a code with no org binding can be repaired.
	const orgId = requireBootstrapOrgId(row.org_id)
	const orgBinding: ApiTokenOrgBinding =
		row.org_binding === 'user' ? 'user' : 'org'

	const burnAndMint = async () => {
		const user = await input.db
			.prepare(
				`SELECT deleting_at, suspended_at, password_changed_at
				 FROM users
				 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(row.user_id)
			.first<{
				deleting_at: string | null
				suspended_at: string | null
				password_changed_at: string | null
			}>()
		const invalidated =
			!user ||
			Boolean(user.deleting_at) ||
			Boolean(user.suspended_at) ||
			isCredentialInvalidatedByStoredPasswordChange({
				issuedAtMs: Date.parse(row.created_at),
				storedPasswordChangedAt: user.password_changed_at,
			})

		const consumedAt = now.toISOString()
		const burned = await input.db
			.prepare(
				`UPDATE cli_credential_bootstrap_codes
				 SET consumed_at = ?
				 WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
			)
			.bind(consumedAt, row.id, consumedAt)
			.run()
		if ((burned.meta.changes ?? 0) !== 1) {
			throw new McpCallerError('CLI bootstrap code was already redeemed.')
		}
		if (invalidated) {
			throw new McpCallerError('Invalid CLI bootstrap code.')
		}

		let scopes: Array<ApiTokenScope>
		try {
			scopes = normalizeApiTokenScopes(
				JSON.parse(row.scopes_json) as Array<unknown>,
			)
		} catch {
			throw new McpCallerError('Stored bootstrap scopes are invalid.')
		}

		const token = await mintApiToken({
			db: input.db,
			userId: row.user_id,
			orgId,
			orgBinding,
			name: row.name,
			scopes,
			idleTtlSeconds: requested.idleTtlSeconds,
			maxLifetimeSeconds: requested.maxLifetimeSeconds,
			createdVia: 'cli-bootstrap',
			// Absolute expiry cannot restart past the window authorized when the
			// code was minted (parent clamps live in stored max_lifetime_seconds).
			parent: {
				scopes,
				maxExpiresAt: new Date(authorizedMaxExpiresAtMs).toISOString(),
			},
			now,
		})
		return { token, userId: row.user_id }
	}

	if (input.env) {
		return withAccountWriteLease({
			db: input.db,
			stableUserId: row.user_id,
			holder: 'api:cliCredentialBootstrapRedeem',
			env: input.env,
			write: burnAndMint,
		})
	}
	return burnAndMint()
}
