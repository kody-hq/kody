import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'

export type PublicUserIdentity = {
	userId: number
	username: string
	email: string
	mcpUserId: PersonId
}

/**
 * Public `/@handle` owner for packages, webhooks, and package-app origins.
 * Team orgs keep a `handles`/`orgs` row after P9 deletes leftover platform
 * `users` rows; person accounts also hold a personal-org handle.
 */
export type PublicOwnerIdentity = {
	handle: string
	ownerId: OwnerId
}

/**
 * Resolve a public handle to the owning org id. Prefer `handles.org_id` (the
 * namespace claim), then live `orgs.slug`. Does not read `users` — post-P9
 * platform orgs have no users row.
 */
export async function findPublicOwnerIdentityByHandle(input: {
	db: D1Database
	handle: string
}): Promise<PublicOwnerIdentity | null> {
	const handle = normalizeUsername(input.handle.trim())
	if (!handle || getUsernameFormatValidationError(handle)) return null

	const fromHandle = await input.db
		.prepare(
			`SELECT h.handle AS handle, h.org_id AS org_id
			 FROM handles h
			 INNER JOIN orgs o ON o.id = h.org_id
			 WHERE h.handle = ?
			   AND h.org_id IS NOT NULL
			   ${andActiveOrgSql('o')}`,
		)
		.bind(handle)
		.first<{ handle: string; org_id: string }>()
	if (fromHandle?.org_id) {
		return {
			handle: fromHandle.handle,
			ownerId: ownerIdFromStored(fromHandle.org_id),
		}
	}

	const fromOrg = await input.db
		.prepare(
			`SELECT slug, id
			 FROM orgs
			 WHERE slug = ?${andLiveDeletedAtSql()} AND suspended_at IS NULL`,
		)
		.bind(handle)
		.first<{ slug: string; id: string }>()
	if (!fromOrg) return null
	return {
		handle: fromOrg.slug,
		ownerId: ownerIdFromStored(fromOrg.id),
	}
}

/**
 * A public handle that {@link findPublicOwnerIdentityByHandle} resolves back
 * to `ownerId`, for building `/@handle/...` URLs that must route to that
 * owner. Tries `preferredHandle` first (a person's username keeps personal
 * URLs stable), then the owner's org slug and claimed handles. Every
 * candidate must round-trip, so a caller-supplied handle can never point a
 * URL at a different owner.
 */
export async function resolvePublicHandleForOwner(input: {
	db: D1Database
	ownerId: OwnerId
	preferredHandle?: string | null
}): Promise<string | null> {
	const candidates = [input.preferredHandle?.trim() ?? '']
	const org = await input.db
		.prepare(`SELECT slug FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`)
		.bind(input.ownerId)
		.first<{ slug: string | null }>()
	candidates.push(org?.slug?.trim() ?? '')
	const claimed = await input.db
		.prepare(
			`SELECT handle FROM handles WHERE org_id = ? ORDER BY created_at, handle`,
		)
		.bind(input.ownerId)
		.all<{ handle: string }>()
	for (const row of claimed.results ?? []) candidates.push(row.handle.trim())
	const tried = new Set<string>()
	for (const candidate of candidates) {
		if (!candidate || tried.has(candidate)) continue
		tried.add(candidate)
		const owner = await findPublicOwnerIdentityByHandle({
			db: input.db,
			handle: candidate,
		})
		if (owner?.ownerId === input.ownerId) return candidate
	}
	return null
}

export async function findPublicUserIdentityByStableUserId(input: {
	db: D1Database
	userId: string
}): Promise<PublicUserIdentity | null> {
	const userId = input.userId.trim()
	if (!userId) return null

	const userRecord = await input.db
		.prepare(
			`SELECT id, username, email, stable_user_id
				FROM users
				WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{
			id: number
			username: string
			email: string
			stable_user_id: string
		}>()
	if (!userRecord) return null

	return {
		userId: userRecord.id,
		username: userRecord.username,
		email: userRecord.email,
		mcpUserId: personIdFromStored(userRecord.stable_user_id),
	}
}

export async function findPublicUserIdentityByUsername(input: {
	db: D1Database
	username: string
}): Promise<PublicUserIdentity | null> {
	const username = input.username.trim()
	if (getUsernameFormatValidationError(username)) return null

	const userRecord = await input.db
		.prepare(
			`SELECT id, username, email, stable_user_id
				FROM users
				WHERE username = ?${andLiveDeletedAtSql()}`,
		)
		.bind(username)
		.first<{
			id: number
			username: string
			email: string
			stable_user_id: string
		}>()
	if (!userRecord) return null

	return {
		userId: userRecord.id,
		username: userRecord.username,
		email: userRecord.email,
		mcpUserId: personIdFromStored(userRecord.stable_user_id),
	}
}

export async function resolvePublicUsername(input: {
	db: D1Database
	username?: string | null
	email?: string | null
}): Promise<string | null> {
	const username = input.username?.trim()
	if (username && !getUsernameFormatValidationError(username)) return username

	const email = input.email?.trim().toLowerCase()
	if (!email) return null

	const userRecord = await input.db
		.prepare(
			`SELECT username
				FROM users
				WHERE email = ?${andLiveDeletedAtSql()}`,
		)
		.bind(email)
		.first<{ username: string | null }>()

	const resolvedUsername = userRecord?.username?.trim()
	return resolvedUsername && !getUsernameFormatValidationError(resolvedUsername)
		? resolvedUsername
		: null
}
