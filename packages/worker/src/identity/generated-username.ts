/**
 * soft-delete-read-filter: opt-out
 *
 * Username and org-slug claim checks must see soft-deleted rows so reserved
 * names stay taken during the restore window (Teams §10.3 full unique indexes).
 */
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
	usernameFromEmail,
} from '#worker/identity/username.ts'

export async function userExistsByUsername(db: D1Database, username: string) {
	const row = await db
		.prepare(`SELECT id FROM users WHERE username = ?`)
		.bind(username)
		.first<{ id: number }>()
	return Boolean(row)
}

/**
 * Whether a username is already claimed on `users`, a live or retired
 * `handles` row, or an org slug (personal org slugs mirror usernames).
 *
 * Pass `exceptStableUserId` when the caller is reclaiming their own retired
 * handle or personal org slug (rename-back).
 */
export async function isUsernameClaimedInIdentity(
	db: D1Database,
	username: string,
	options?: { exceptStableUserId?: string; exceptOrgId?: string },
) {
	const normalized = normalizeUsername(username)
	if (!normalized) return false
	const except = options?.exceptStableUserId?.trim() || null
	const exceptOrg = options?.exceptOrgId?.trim() || except
	if (except) {
		const otherUser = await db
			.prepare(
				`SELECT 1 AS present FROM users
				 WHERE username = ? AND stable_user_id != ?`,
			)
			.bind(normalized, except)
			.first<{ present: number }>()
		if (otherUser) return true
	} else if (await userExistsByUsername(db, normalized)) {
		return true
	}

	if (except) {
		// Own live handle (user_id) or own org-held retired handle (org_id)
		// may be reclaimed. Express foreign claims positively so null/null
		// historical redirects stay claimed (no SQL three-valued DROP).
		const foreignHandle = await db
			.prepare(
				`SELECT 1 AS present FROM handles
				 WHERE handle = ?
				   AND (
				     (user_id IS NULL AND org_id IS NULL)
				     OR (user_id IS NOT NULL AND user_id != ?)
				     OR (
				       user_id IS NULL
				       AND org_id IS NOT NULL
				       AND org_id != ?
				     )
				   )`,
			)
			.bind(normalized, except, exceptOrg)
			.first<{ present: number }>()
		if (foreignHandle) return true
		const foreignOrg = await db
			.prepare(
				`SELECT 1 AS present FROM orgs
				 WHERE slug = ? AND id != ?`,
			)
			.bind(normalized, exceptOrg)
			.first<{ present: number }>()
		return Boolean(foreignOrg)
	}

	const handleRow = await db
		.prepare(`SELECT 1 AS present FROM handles WHERE handle = ?`)
		.bind(normalized)
		.first<{ present: number }>()
	if (handleRow) return true
	const orgSlug = await db
		.prepare(`SELECT 1 AS present FROM orgs WHERE slug = ?`)
		.bind(normalized)
		.first<{ present: number }>()
	return Boolean(orgSlug)
}

/**
 * Find an available username starting from a preferred base (for example a
 * provider handle or an email local part). Numeric suffixes are used only when
 * the base itself is claimable but taken — a reserved base with substring
 * eligibility still collides after `-2`. Otherwise a random compact candidate
 * is drawn until one is claimable.
 */
export async function getAvailableUsernameFromBase(
	db: D1Database,
	base: string,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	// Provider handles may contain characters the username format rejects;
	// map them the same way usernameFromEmail maps email local parts.
	const normalizedBase = normalizeUsername(base)
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
		.slice(0, 32)
		.replace(/[^a-z0-9]+$/g, '')

	const baseError = normalizedBase
		? await getEffectiveUsernameValidationError(normalizedBase, env)
		: 'Username is required.'
	if (
		normalizedBase &&
		!baseError &&
		!(await isUsernameClaimedInIdentity(db, normalizedBase))
	) {
		return normalizedBase
	}

	if (normalizedBase && !baseError) {
		const prefix = normalizedBase.slice(0, 27).replace(/-+$/g, '') || 'n'
		for (let suffix = 2; suffix <= 100; suffix += 1) {
			const candidate = `${prefix}-${suffix}`
			if (
				!(await getEffectiveUsernameValidationError(candidate, env)) &&
				!(await isUsernameClaimedInIdentity(db, candidate))
			) {
				return candidate
			}
		}
	}

	for (let attempt = 0; attempt < 32; attempt += 1) {
		const bytes = new Uint8Array(6)
		crypto.getRandomValues(bytes)
		const random = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, '0'),
		)
			.join('')
			.toLowerCase()
		const candidate = `n${random}`
		if (
			!(await getEffectiveUsernameValidationError(candidate, env)) &&
			!(await isUsernameClaimedInIdentity(db, candidate))
		) {
			return candidate
		}
	}

	throw new Error('Unable to generate an available username.')
}

export async function getAvailableGeneratedUsername(
	db: D1Database,
	email: string,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	return getAvailableUsernameFromBase(db, usernameFromEmail(email), env)
}
