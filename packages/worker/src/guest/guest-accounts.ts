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
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
import { mintPersonalOrgIdForSignup } from '#worker/orgs/signup-provision.ts'
import { personalOrgProvisionStatements } from '#worker/orgs/provision.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'

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
 * resources through the existing per-org limit overrides. Removed at claim.
 */
export const guestLimitOverrides: ReadonlyArray<readonly [string, number]> = [
	['execute_unique_workers_per_day', 200],
	['execute_unique_workers_per_week', 200],
	['outbound_fetches_per_day', 500],
	['outbound_fetches_per_week', 500],
	['job_runs_per_day', 50],
	['automation_invocations_per_day', 50],
	['email_sends_per_day', 0],
	['email_receives_per_day', 0],
	['unique_worker_days_per_month', 1],
	['durable_object_rows_read_per_month', 1_000_000],
	['execute_calls_per_minute', 30],
]
export const guestLimitOverrideReason = 'guest_account'

export type GuestPhase = 'active' | 'hold'

export type GuestAccount = {
	personId: PersonId
	personalOrgId: OwnerId
	claimCode: string
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
		claimCode: row.claim_code,
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

export function guestPhase(expiresAt: string, now: Date = new Date()) {
	return Date.parse(expiresAt) > now.getTime() ? 'active' : 'hold'
}

export function guestClaimUrl(baseUrl: string, claimCode: string) {
	return `${baseUrl.replace(/\/+$/, '')}/claim/${claimCode}`
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
	db: D1Database,
	claimCode: string,
): Promise<GuestAccount | null> {
	if (!isGuestClaimCodeShape(claimCode)) return null
	const row = await db
		.prepare(`SELECT * FROM guest_accounts WHERE claim_code = ?`)
		.bind(claimCode)
		.first<GuestAccountRow>()
	return row ? toGuestAccount(row) : null
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
			expiresAt: string
	  }
	| { ok: false; reason: 'rate_limited'; retryAfterSeconds: number | null }

/**
 * Create the guest person, personal org, role, guest row, and limit
 * overrides in one D1 batch (one transaction).
 */
export async function createGuestAccount(input: {
	db: D1Database
	requestIp: string | null
	clientName: string | null
	now?: Date
}): Promise<GuestCreateResult> {
	const { db } = input
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
							person_id, personal_org_id, claim_code, client_name,
							expires_at, delete_at, created_at
						) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						personId,
						orgId,
						claimCode,
						clientName,
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
					.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
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
				expiresAt,
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
				 SET claimed_at = ?, claimed_into_person_id = ?, claimed_into_org_id = ?
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
