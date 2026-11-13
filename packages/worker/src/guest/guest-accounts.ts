/**
 * Claimable guest accounts (ADR 0091 amendment). A guest is a person plus a
 * personal org created from the OAuth authorize screen's Try it out choice.
 * Full access lasts {@link guestFullAccessMs}; the account is then read-only
 * for {@link guestHoldMs} and deleted through the account-deletion path.
 */
import {
	mintPersonId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { openPlatformSecret, sealPlatformSecret } from '#mcp/secrets/crypto.ts'
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
import { mintPersonalOrgIdForSignup } from '#worker/orgs/signup-provision.ts'
import { personalOrgProvisionStatements } from '#worker/orgs/provision.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import { ceilingLimitOverrideReason } from '#worker/entitlements/limit-overrides.ts'

export const guestFullAccessMs = 24 * 60 * 60 * 1000
export const guestHoldMs = 7 * 24 * 60 * 60 * 1000
/** Agent guidance: show the claim link again once this much time is left. */
export const guestReminderWindowMs = 2 * 60 * 60 * 1000

/** Guest addresses never receive mail; `.invalid` is reserved (RFC 2606). */
export const guestEmailDomain = 'guest.kody.invalid'

export const guestClaimCapabilityName = 'guestClaimStart'
export const guestClaimFinishCapabilityName = 'guestClaimFinish'

/** Guest creations per IP per day. */
export const guestCreateIpRateLimit: RateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 24 * 60 * 60,
}

/** Guest creations across the platform per day. */
export const guestCreateDailyRateLimit: RateLimitConfig = {
	maxRequests: 1000,
	windowSeconds: 24 * 60 * 60,
}

/**
 * About $1 of house compute with a hard stop: tight caps on the metered
 * resources through per-org ceiling limit overrides. Removed at claim.
 */
export const guestLimitOverrides: ReadonlyArray<readonly [string, number]> = [
	['execute_unique_workers_per_day', 200],
	['outbound_fetches_per_day', 500],
	['job_runs_per_day', 50],
	['automation_invocations_per_day', 50],
	['email_sends_per_day', 0],
	['email_receives_per_day', 0],
	['execute_calls_per_minute', 30],
]
export const guestLimitOverrideReason = ceilingLimitOverrideReason

export type GuestPhase = 'active' | 'hold'

export type GuestAccount = {
	personId: PersonId
	personalOrgId: OwnerId
	/** SHA-256 lookup hash (legacy rows: plaintext until the backfill). */
	claimCodeLookup: string
	claimCodeEncrypted: string | null
	clientName: string | null
	expiresAt: string
	deleteAt: string
	createdAt: string
	claimedAt: string | null
	claimedIntoPersonId: string | null
	claimedIntoOrgId: string | null
}

type GuestAccountRow = {
	person_id: string
	personal_org_id: string
	claim_code: string
	claim_code_encrypted: string | null
	client_name: string | null
	expires_at: string
	delete_at: string
	created_at: string
	claimed_at: string | null
	claimed_into_person_id: string | null
	claimed_into_org_id: string | null
}

function toGuestAccount(row: GuestAccountRow): GuestAccount {
	return {
		personId: row.person_id as PersonId,
		personalOrgId: row.personal_org_id as OwnerId,
		claimCodeLookup: row.claim_code,
		claimCodeEncrypted: row.claim_code_encrypted,
		clientName: row.client_name,
		expiresAt: row.expires_at,
		deleteAt: row.delete_at,
		createdAt: row.created_at,
		claimedAt: row.claimed_at,
		claimedIntoPersonId: row.claimed_into_person_id,
		claimedIntoOrgId: row.claimed_into_org_id,
	}
}

const base32Alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'

function randomToken(length: number) {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	let out = ''
	for (const byte of bytes) out += base32Alphabet[byte % base32Alphabet.length]
	return out
}

export function mintGuestClaimCode() {
	return randomToken(24)
}

export function isGuestClaimCodeShape(value: string) {
	return /^[a-z2-9]{24}$/.test(value)
}

export function isGuestEmail(email: string | null | undefined) {
	return (
		typeof email === 'string' &&
		email.trim().toLowerCase().endsWith(`@${guestEmailDomain}`)
	)
}

export function guestPhase(
	expiresAt: string,
	now: Date = new Date(),
): GuestPhase {
	return Date.parse(expiresAt) > now.getTime() ? 'active' : 'hold'
}

export function guestClaimUrl(baseUrl: string, claimCode: string) {
	return `${baseUrl.replace(/\/+$/, '')}/claim/${claimCode}`
}

export type GuestSecretEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

/** Lookup hash stored in guest_accounts.claim_code. */
export function guestClaimCodeHash(claimCode: string) {
	return sha256Hex(`guest-claim-url:${claimCode}`)
}

function guestClaimCodeContext(personId: string) {
	return `guest:${personId}:claim-code`
}

function sealGuestClaimCode(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	personId: string,
	claimCode: string,
) {
	return sealPlatformSecret(
		env,
		'guest-claim-code',
		guestClaimCodeContext(personId),
		claimCode,
	)
}

/**
 * Converts one legacy row (plaintext claim_code) to hash plus sealed copy.
 * Compare-and-swap on the plaintext so a concurrent claim or rerun is safe.
 */
async function sealLegacyGuestClaimCode(
	env: GuestSecretEnv,
	personId: string,
	claimCode: string,
) {
	const result = await env.APP_DB.prepare(
		`UPDATE guest_accounts SET claim_code = ?, claim_code_encrypted = ?
		 WHERE person_id = ? AND claim_code = ?`,
	)
		.bind(
			await guestClaimCodeHash(claimCode),
			await sealGuestClaimCode(env, personId, claimCode),
			personId,
			claimCode,
		)
		.run()
	return (result.meta?.changes ?? 0) > 0
}

/** The guest's own claim code, opened for display. Null fails closed. */
export async function readGuestClaimCode(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	guest: GuestAccount,
): Promise<string | null> {
	if (guest.claimCodeEncrypted) {
		const code = await openPlatformSecret(
			env,
			'guest-claim-code',
			guestClaimCodeContext(guest.personId),
			guest.claimCodeEncrypted,
		).catch(() => null)
		if (!code || !isGuestClaimCodeShape(code)) return null
		const expected = await guestClaimCodeHash(code)
		return (await timingSafeEqualString(expected, guest.claimCodeLookup))
			? code
			: null
	}
	// Legacy plaintext row: remove with the backfill compatibility reads.
	return isGuestClaimCodeShape(guest.claimCodeLookup)
		? guest.claimCodeLookup
		: null
}

export async function readGuestClaimUrl(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	baseUrl: string,
	guest: GuestAccount,
) {
	const code = await readGuestClaimCode(env, guest)
	return code ? guestClaimUrl(baseUrl, code) : null
}

/** Display form for copy: `kody.codes/claim/<code>`. */
export function guestClaimLinkLabel(claimUrl: string) {
	return claimUrl.replace(/^https?:\/\//, '')
}

export async function readGuestAccountByPerson(
	db: D1Database,
	personId: string,
): Promise<GuestAccount | null> {
	const row = await db
		.prepare(`SELECT * FROM guest_accounts WHERE person_id = ?`)
		.bind(personId)
		.first<GuestAccountRow>()
	return row ? toGuestAccount(row) : null
}

export async function readGuestAccountByClaimCode(
	env: GuestSecretEnv,
	claimCode: string,
): Promise<GuestAccount | null> {
	if (!isGuestClaimCodeShape(claimCode)) return null
	const hash = await guestClaimCodeHash(claimCode)
	// Second bind matches legacy plaintext rows until the backfill finishes.
	const row = await env.APP_DB.prepare(
		`SELECT * FROM guest_accounts WHERE claim_code IN (?, ?)`,
	)
		.bind(hash, claimCode)
		.first<GuestAccountRow>()
	if (!row) return null
	if (await timingSafeEqualString(row.claim_code, hash)) {
		return toGuestAccount(row)
	}
	if (!(await timingSafeEqualString(row.claim_code, claimCode))) return null
	await sealLegacyGuestClaimCode(env, row.person_id, claimCode)
	const sealed = await env.APP_DB.prepare(
		`SELECT * FROM guest_accounts WHERE person_id = ? AND claim_code = ?`,
	)
		.bind(row.person_id, hash)
		.first<GuestAccountRow>()
	return sealed ? toGuestAccount(sealed) : null
}

export type GuestClaimCodeBackfillResult = {
	scanned: number
	sealed: number
	remainingPlaintext: number
	nextCursor: string | null
}

/**
 * Bounded backfill: converts guest_accounts rows whose claim_code is still
 * the plaintext code into hash plus sealed copy. Safe to rerun.
 */
// Claimed guests drop claim_code_encrypted, so plaintext means claim_code is
// not yet a 64-char SHA-256 hex lookup hash.
const guestPlaintextClaimCodeSql = 'length(claim_code) <> 64'

export async function sealPlaintextGuestClaimCodes(input: {
	env: GuestSecretEnv
	dryRun: boolean
	limit: number
	cursor?: string | null
}): Promise<GuestClaimCodeBackfillResult> {
	const db = input.env.APP_DB
	const rows = await db
		.prepare(
			`SELECT person_id, claim_code FROM guest_accounts
			 WHERE ${guestPlaintextClaimCodeSql} AND person_id > ?
			 ORDER BY person_id LIMIT ?`,
		)
		.bind(input.cursor ?? '', input.limit)
		.all<{ person_id: string; claim_code: string }>()
	const page = rows.results ?? []
	let sealed = 0
	for (const row of page) {
		if (input.dryRun || !isGuestClaimCodeShape(row.claim_code)) continue
		if (
			await sealLegacyGuestClaimCode(input.env, row.person_id, row.claim_code)
		) {
			sealed += 1
		}
	}
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM guest_accounts
			 WHERE ${guestPlaintextClaimCodeSql}`,
		)
		.first<{ count: number }>()
	return {
		scanned: page.length,
		sealed,
		remainingPlaintext: Number(remaining?.count ?? 0),
		nextCursor:
			page.length < input.limit ? null : (page.at(-1)?.person_id ?? null),
	}
}

/** Grants minted for a merged guest resolve to the claiming person. */
export async function readGuestAlias(
	db: D1Database,
	guestPersonId: string,
): Promise<{ personId: PersonId; orgId: OwnerId } | null> {
	const row = await db
		.prepare(
			`SELECT claimed_into_person_id, claimed_into_org_id
			 FROM guest_accounts
			 WHERE person_id = ? AND claimed_into_person_id IS NOT NULL`,
		)
		.bind(guestPersonId)
		.first<{ claimed_into_person_id: string; claimed_into_org_id: string }>()
	if (!row) return null
	return {
		personId: row.claimed_into_person_id as PersonId,
		orgId: row.claimed_into_org_id as OwnerId,
	}
}

/**
 * The org a claimed guest's old org slug now points at, for `personId`.
 * Clients that stored the guest slug (CLI `--org`) keep working after claim.
 */
export async function readClaimedGuestOrgForSlug(
	db: D1Database,
	input: { slug: string; personId: string },
): Promise<OwnerId | null> {
	const row = await db
		.prepare(
			`SELECT COALESCE(claimed_into_org_id, personal_org_id) AS org_id
			 FROM guest_accounts
			 WHERE guest_slug = ? AND claimed_at IS NOT NULL
			   AND (person_id = ? OR claimed_into_person_id = ?)`,
		)
		.bind(input.slug, input.personId, input.personId)
		.first<{ org_id: string }>()
	return row ? (row.org_id as OwnerId) : null
}

/** Guest person ids merged into `personId` (their grants belong to it). */
export async function listGuestAliasesForPerson(
	db: D1Database,
	personId: string,
): Promise<Array<PersonId>> {
	const rows = await db
		.prepare(
			`SELECT person_id FROM guest_accounts WHERE claimed_into_person_id = ?`,
		)
		.bind(personId)
		.all<{ person_id: string }>()
	return (rows.results ?? []).map((row) => row.person_id as PersonId)
}

export type GuestCreateResult =
	| {
			ok: true
			personId: PersonId
			personalOrgId: OwnerId
			userRowId: number
			email: string
			username: string
			claimCode: string
			createdAt: string
			expiresAt: string
			deleteAt: string
	  }
	| { ok: false; reason: 'rate_limited'; retryAfterSeconds: number | null }

/**
 * Create the guest person, personal org, role, guest row, and limit
 * overrides in one D1 batch (one transaction).
 */
export async function createGuestAccount(input: {
	env: GuestSecretEnv
	requestIp: string | null
	clientName: string | null
	now?: Date
}): Promise<GuestCreateResult> {
	const db = input.env.APP_DB
	const ipKey = input.requestIp?.trim() || 'unknown'
	const ipLimit = await checkRateLimit(
		db,
		`guest-create:ip:${ipKey}`,
		guestCreateIpRateLimit,
	)
	if (!ipLimit.allowed) {
		return {
			ok: false,
			reason: 'rate_limited',
			retryAfterSeconds: ipLimit.retryAfterSeconds,
		}
	}
	const dailyLimit = await checkRateLimit(
		db,
		'guest-create:daily',
		guestCreateDailyRateLimit,
	)
	if (!dailyLimit.allowed) {
		return {
			ok: false,
			reason: 'rate_limited',
			retryAfterSeconds: dailyLimit.retryAfterSeconds,
		}
	}

	const now = input.now ?? new Date()
	const createdAt = now.toISOString()
	const expiresAt = new Date(now.getTime() + guestFullAccessMs).toISOString()
	const deleteAt = new Date(
		now.getTime() + guestFullAccessMs + guestHoldMs,
	).toISOString()
	const clientName = input.clientName?.trim().slice(0, 120) || null

	let lastError: unknown = null
	for (let attempt = 0; attempt < 3; attempt++) {
		const personId = mintPersonId()
		const orgId = mintPersonalOrgIdForSignup()
		const suffix = randomToken(10)
		const username = `guest-${suffix}`
		const email = `${suffix}@${guestEmailDomain}`
		const claimCode = mintGuestClaimCode()
		const claimCodeHash = await guestClaimCodeHash(claimCode)
		const claimCodeEncrypted = await sealGuestClaimCode(
			input.env,
			personId,
			claimCode,
		)
		try {
			const results = await db.batch([
				db.prepare('PRAGMA defer_foreign_keys = ON'),
				db
					.prepare(
						`INSERT INTO users (
							username, email, stable_user_id, personal_org_id, password_hash,
							email_verified_at, guest_expires_at, last_active_at,
							created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						username,
						email,
						personId,
						orgId,
						unusablePasswordHash.guestCreated,
						createdAt,
						expiresAt,
						createdAt,
						createdAt,
						createdAt,
					),
				...personalOrgProvisionStatements(db, {
					stableUserId: personId,
					orgId,
					username,
					createdAt,
					displayName: 'Guest',
					profileVisibility: 'private',
					plan: 'free',
					signupWelcomeCreditsPending: 0,
				}),
				db
					.prepare(
						`INSERT OR IGNORE INTO user_roles (user_id, role_id)
						 SELECT u.id, r.id FROM users u, roles r
						 WHERE u.stable_user_id = ? AND r.name = 'user'`,
					)
					.bind(personId),
				db
					.prepare(
						`INSERT INTO guest_accounts (
							person_id, personal_org_id, claim_code, claim_code_encrypted,
							client_name, guest_slug, expires_at, delete_at, created_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						personId,
						orgId,
						claimCodeHash,
						claimCodeEncrypted,
						clientName,
						username,
						expiresAt,
						deleteAt,
						createdAt,
					),
				...guestLimitOverrides.map(([key, value]) =>
					db
						.prepare(
							`INSERT INTO org_limit_overrides (
								org_id, limit_key, limit_value, reason, expires_at,
								set_by_user_id, created_at, updated_at
							) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
							ON CONFLICT (org_id, limit_key) DO NOTHING`,
						)
						.bind(
							orgId,
							key,
							value,
							guestLimitOverrideReason,
							personId,
							createdAt,
							createdAt,
						),
				),
				db
					.prepare(
						`SELECT id FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
					)
					.bind(personId),
			])
			const last = results[results.length - 1] as D1Result<{ id: number }>
			const userRowId = last.results?.[0]?.id
			if (typeof userRowId !== 'number') {
				throw new Error('Guest user row missing after create.')
			}
			return {
				ok: true,
				personId,
				personalOrgId: orgId,
				userRowId,
				email,
				username,
				claimCode,
				createdAt,
				expiresAt,
				deleteAt,
			}
		} catch (error) {
			lastError = error
			if (!String(error).includes('UNIQUE')) throw error
		}
	}
	throw lastError
}

/** Statements that turn a guest into a regular account (claim). */
export function guestConversionStatements(
	db: D1Database,
	input: {
		personId: string
		orgId: string
		now: string
		intoPersonId?: string
		intoOrgId?: string
	},
) {
	return [
		db
			.prepare(
				`UPDATE guest_accounts
				 SET claimed_at = ?, claimed_into_person_id = ?, claimed_into_org_id = ?,
				     claim_code_encrypted = NULL
				 WHERE person_id = ? AND claimed_at IS NULL`,
			)
			.bind(
				input.now,
				input.intoPersonId ?? null,
				input.intoOrgId ?? null,
				input.personId,
			),
		db
			.prepare(
				`DELETE FROM org_limit_overrides WHERE org_id = ? AND reason = ?`,
			)
			.bind(input.orgId, guestLimitOverrideReason),
		db
			.prepare(`DELETE FROM guest_claim_codes WHERE person_id = ?`)
			.bind(input.personId),
	]
}

/** Grant props for a merged guest's grant, rebound to the claiming person. */
export function aliasedGuestGrantProps<T extends Record<string, unknown>>(
	grantProps: T,
	alias: { personId: string; orgId: string },
): T {
	return {
		...grantProps,
		userId: alias.personId,
		personId: alias.personId,
		orgId: alias.orgId,
	}
}
