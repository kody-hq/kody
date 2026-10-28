/**
 * soft-delete-read-filter: opt-out
 *
 * Finds soft-deleted accounts by design: a fresh signup with the same email
 * supersedes them so a deleted account never blocks its own owner.
 */
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { normalizeUsername } from '#worker/identity/username.ts'

/**
 * Released tombstones move email and username to values no signup can ever
 * produce (`.invalid` TLD, `~` is outside the handle alphabet) so the
 * original values are free while ids stay unique for the purge lane.
 */
const releasedEmailDomain = 'released.kody.invalid'
const releasedUsernamePrefix = '~released-'

export type ReleasableDeletedAccount = {
	id: number
	stableUserId: string
	personalOrgId: string
	username: string
}

export function isReleasedAccountEmail(email: string) {
	return email.trim().toLowerCase().endsWith(`@${releasedEmailDomain}`)
}

function releasedEmailFor(account: ReleasableDeletedAccount) {
	return `released-${account.id}@${releasedEmailDomain}`
}

function releasedUsernameFor(account: ReleasableDeletedAccount) {
	return `${releasedUsernamePrefix}${account.id}`
}

function releasedOrgSlugFor(orgId: string) {
	return `${releasedUsernamePrefix}${orgId}`
}

/** Soft-deleted accounts whose current address is `email`. */
export async function findSoftDeletedAccountsHoldingEmail(
	db: D1Database,
	email: string,
): Promise<Array<ReleasableDeletedAccount>> {
	const normalized = normalizeEmail(email)
	if (!normalized) return []
	const rows = await db
		.prepare(
			`SELECT id, stable_user_id, personal_org_id, username
			 FROM users
			 WHERE deleted_at IS NOT NULL AND email = ?
			 ORDER BY id`,
		)
		.bind(normalized)
		.all<{
			id: number
			stable_user_id: string
			personal_org_id: string | null
			username: string
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		stableUserId: row.stable_user_id,
		personalOrgId: row.personal_org_id?.trim() || row.stable_user_id,
		username: row.username,
	}))
}

/**
 * True when `username` is held only by soft-deleted accounts that `email`
 * would supersede, so the same person may reclaim their old handle.
 */
export async function isUsernameReleasableForEmail(
	db: D1Database,
	username: string,
	email: string,
) {
	const normalized = normalizeUsername(username)
	if (!normalized) return false
	const accounts = await findSoftDeletedAccountsHoldingEmail(db, email)
	return accounts.some(
		(account) => normalizeUsername(account.username) === normalized,
	)
}

/**
 * Supersede soft-deleted accounts holding `email`: move their email and
 * username to released tombstones, release their email claims, provider
 * links, handles, personal org slug, and platform inbox addresses. Ids,
 * `deleted_at`, and every owned row stay for the purge lane (ADR 0066); the
 * account can no longer be restored once superseded.
 */
export async function releaseSoftDeletedAccountsForEmail(
	db: D1Database,
	email: string,
	now: Date = new Date(),
) {
	const normalized = normalizeEmail(email)
	if (!normalized) return { releasedCount: 0, releasedUsernames: [] }
	const releasedAt = now.toISOString()
	// A deleted account's former-email claim only frees the address.
	await db
		.prepare(
			`UPDATE user_email_claims
			 SET status = 'released', released_at = ?, updated_at = ?
			 WHERE email = ? AND status = 'claimed'
			   AND user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)`,
		)
		.bind(releasedAt, releasedAt, normalized)
		.run()
	const accounts = await findSoftDeletedAccountsHoldingEmail(db, normalized)
	return releaseSoftDeletedAccounts(db, accounts, now)
}

/**
 * The soft-deleted account behind a provider connection, so a person who
 * proves the same provider identity can supersede it.
 */
export async function findSoftDeletedAccountById(
	db: D1Database,
	userId: number,
): Promise<ReleasableDeletedAccount | null> {
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, personal_org_id, username
			 FROM users
			 WHERE id = ? AND deleted_at IS NOT NULL`,
		)
		.bind(userId)
		.first<{
			id: number
			stable_user_id: string
			personal_org_id: string | null
			username: string
		}>()
	if (!row) return null
	return {
		id: row.id,
		stableUserId: row.stable_user_id,
		personalOrgId: row.personal_org_id?.trim() || row.stable_user_id,
		username: row.username,
	}
}

export async function releaseSoftDeletedAccounts(
	db: D1Database,
	accounts: ReadonlyArray<ReleasableDeletedAccount>,
	now: Date = new Date(),
) {
	const releasedAt = now.toISOString()
	for (const account of accounts) {
		await db.batch([
			db
				.prepare(
					`UPDATE users
					 SET email = ?, username = ?, updated_at = ?
					 WHERE id = ? AND deleted_at IS NOT NULL`,
				)
				.bind(
					releasedEmailFor(account),
					releasedUsernameFor(account),
					releasedAt,
					account.id,
				),
			db
				.prepare(
					`UPDATE user_email_claims
					 SET status = 'released', released_at = ?, updated_at = ?
					 WHERE user_id = ? AND status = 'claimed'`,
				)
				.bind(releasedAt, releasedAt, account.id),
			db
				.prepare(`DELETE FROM oauth_connections WHERE user_id = ?`)
				.bind(account.id),
			db
				.prepare(
					`DELETE FROM handles
					 WHERE user_id = ?
					    OR (
					      org_id = ?
					      AND EXISTS (
					        SELECT 1 FROM orgs
					        WHERE id = ? AND deleted_at IS NOT NULL
					      )
					    )`,
				)
				.bind(
					account.stableUserId,
					account.personalOrgId,
					account.personalOrgId,
				),
			db
				.prepare(
					`UPDATE orgs SET slug = ?, updated_at = ?
					 WHERE id = ? AND deleted_at IS NOT NULL`,
				)
				.bind(
					releasedOrgSlugFor(account.personalOrgId),
					releasedAt,
					account.personalOrgId,
				),
			db
				.prepare(
					`UPDATE email_inbox_addresses
					 SET address = '~released-' || id || '-' || address,
					     enabled = 0,
					     updated_at = ?
					 WHERE user_id IN (?, ?)
					   AND address NOT LIKE '~released-%'`,
				)
				.bind(releasedAt, account.stableUserId, account.personalOrgId),
		])
	}
	return {
		releasedCount: accounts.length,
		releasedUsernames: accounts
			.map((account) => account.username)
			.filter((username) => !username.startsWith(releasedUsernamePrefix)),
	}
}
