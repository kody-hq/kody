import {
	readPackageAppOauthScope,
	serializePackageAppOauthScopes,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'

export type PackageAppOauthGrant = {
	id: string
	personId: string
	orgUsername: string
	kodyId: string
	scopes: Array<PackageAppOauthScope>
	createdAt: string
	lastUsedAt: string | null
}

type GrantRow = {
	id: string
	person_id: string
	org_username: string
	kody_id: string
	scopes: string
	created_at: string
	last_used_at: string | null
}

const grantColumns = `id, person_id, org_username, kody_id, scopes, created_at, last_used_at`

function parseScopes(raw: string): Array<PackageAppOauthScope> {
	return raw.split(/\s+/).flatMap((part) => {
		const scope = readPackageAppOauthScope(part)
		return scope ? [scope] : []
	})
}

function toGrant(row: GrantRow): PackageAppOauthGrant {
	return {
		id: row.id,
		personId: row.person_id,
		orgUsername: row.org_username,
		kodyId: row.kody_id,
		scopes: parseScopes(row.scopes),
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at ?? null,
	}
}

export async function findLivePackageAppOauthGrant(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
}): Promise<PackageAppOauthGrant | null> {
	const row = await input.db
		.prepare(
			`SELECT ${grantColumns}
			 FROM package_app_oauth_grants
			 WHERE person_id = ? AND org_username = ? AND kody_id = ?
			   AND revoked_at IS NULL
			 LIMIT 1`,
		)
		.bind(input.personId, input.orgUsername, input.kodyId)
		.first<GrantRow>()
	return row ? toGrant(row) : null
}

/** Every live app grant a person gave, newest first (Connected apps page). */
export async function listLivePackageAppOauthGrantsForPerson(input: {
	db: D1Database
	personId: string
}): Promise<Array<PackageAppOauthGrant>> {
	const result = await input.db
		.prepare(
			`SELECT ${grantColumns}
			 FROM package_app_oauth_grants
			 WHERE person_id = ? AND revoked_at IS NULL
			 ORDER BY created_at DESC, id ASC
			 LIMIT 200`,
		)
		.bind(input.personId)
		.all<GrantRow>()
	return (result.results ?? []).map(toGrant)
}

export function grantCoversScopes(
	grant: PackageAppOauthGrant,
	requested: ReadonlyArray<PackageAppOauthScope>,
) {
	const have = new Set(grant.scopes)
	return requested.every((scope) => have.has(scope))
}

/**
 * The grant records the scope set the person consented to. A later request
 * for more scopes asks again; asking for fewer keeps working.
 */
export async function upsertPackageAppOauthGrant(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
	scopes: ReadonlyArray<PackageAppOauthScope>
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	const scopes = serializePackageAppOauthScopes(input.scopes)
	const existing = await findLivePackageAppOauthGrant({
		db: input.db,
		personId: input.personId,
		orgUsername: input.orgUsername,
		kodyId: input.kodyId,
	})
	if (existing) {
		const merged = serializePackageAppOauthScopes([
			...existing.scopes,
			...input.scopes,
		])
		await input.db
			.prepare(`UPDATE package_app_oauth_grants SET scopes = ? WHERE id = ?`)
			.bind(merged, existing.id)
			.run()
		return existing.id
	}
	const id = crypto.randomUUID()
	await input.db
		.prepare(
			`INSERT INTO package_app_oauth_grants
			 (id, person_id, org_username, kody_id, scopes, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, input.personId, input.orgUsername, input.kodyId, scopes, now)
		.run()
	return id
}

export async function revokePackageAppOauthGrantsForPersonApp(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	await input.db
		.prepare(
			`UPDATE package_app_oauth_grants
			 SET revoked_at = ?
			 WHERE person_id = ? AND org_username = ? AND kody_id = ?
			   AND revoked_at IS NULL`,
		)
		.bind(now, input.personId, input.orgUsername, input.kodyId)
		.run()
}

export async function revokePackageAppOauthGrantScope(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
	scope: string
	now?: Date
}) {
	const scope = readPackageAppOauthScope(input.scope)
	if (!scope || scope === 'profile') return false
	const grant = await findLivePackageAppOauthGrant(input)
	if (!grant?.scopes.includes(scope)) return false
	const scopes = serializePackageAppOauthScopes([
		'profile',
		...grant.scopes.filter((existing) => existing !== scope),
	])
	await input.db
		.prepare(
			`UPDATE package_app_oauth_grants
			 SET scopes = ?
			 WHERE id = ? AND revoked_at IS NULL`,
		)
		.bind(scopes, grant.id)
		.run()
	return true
}

/** Last-use timestamps move at most once a minute per grant. */
export const packageAppOauthGrantLastUsedResolutionMs = 60_000

export async function touchPackageAppOauthGrantLastUsed(input: {
	db: D1Database
	grantId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const threshold = new Date(
		now.getTime() - packageAppOauthGrantLastUsedResolutionMs,
	).toISOString()
	await input.db
		.prepare(
			`UPDATE package_app_oauth_grants
			 SET last_used_at = ?
			 WHERE id = ? AND revoked_at IS NULL
			   AND (last_used_at IS NULL OR last_used_at < ?)`,
		)
		.bind(now.toISOString(), input.grantId, threshold)
		.run()
}
