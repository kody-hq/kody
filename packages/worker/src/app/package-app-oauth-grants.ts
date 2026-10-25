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
const maxPackageAppOauthGrantUpdateAttempts = 5

type LiveGrantLookupInput = {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
}

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

async function findLivePackageAppOauthGrantRow(
	input: LiveGrantLookupInput,
): Promise<GrantRow | null> {
	return input.db
		.prepare(
			`SELECT ${grantColumns}
			 FROM package_app_oauth_grants
			 WHERE person_id = ? AND org_username = ? AND kody_id = ?
			   AND revoked_at IS NULL
			 LIMIT 1`,
		)
		.bind(input.personId, input.orgUsername, input.kodyId)
		.first<GrantRow>()
}

export async function findLivePackageAppOauthGrant(
	input: LiveGrantLookupInput,
): Promise<PackageAppOauthGrant | null> {
	const row = await findLivePackageAppOauthGrantRow(input)
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
	for (
		let attempt = 0;
		attempt < maxPackageAppOauthGrantUpdateAttempts;
		attempt++
	) {
		const existing = await findLivePackageAppOauthGrantRow(input)
		if (existing) {
			const merged = serializePackageAppOauthScopes([
				...toGrant(existing).scopes,
				...input.scopes,
			])
			const updated = await input.db
				.prepare(
					`UPDATE package_app_oauth_grants
					 SET scopes = ?
					 WHERE id = ? AND scopes = ? AND revoked_at IS NULL
					 RETURNING id`,
				)
				.bind(merged, existing.id, existing.scopes)
				.first<{ id: string }>()
			if (updated) return updated.id
			continue
		}

		const id = crypto.randomUUID()
		const inserted = await input.db
			.prepare(
				`INSERT INTO package_app_oauth_grants
				 (id, person_id, org_username, kody_id, scopes, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING
				 RETURNING id`,
			)
			.bind(id, input.personId, input.orgUsername, input.kodyId, scopes, now)
			.first<{ id: string }>()
		if (inserted) return inserted.id
	}
	throw new Error(
		'Package app OAuth grant changed repeatedly while updating scopes',
	)
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
	for (
		let attempt = 0;
		attempt < maxPackageAppOauthGrantUpdateAttempts;
		attempt++
	) {
		const grant = await findLivePackageAppOauthGrantRow(input)
		if (!grant) return false
		const currentScopes = toGrant(grant).scopes
		if (!currentScopes.includes(scope)) return false
		const scopes = serializePackageAppOauthScopes([
			'profile',
			...currentScopes.filter((existing) => existing !== scope),
		])
		const updated = await input.db
			.prepare(
				`UPDATE package_app_oauth_grants
				 SET scopes = ?
				 WHERE id = ? AND scopes = ? AND revoked_at IS NULL
				 RETURNING id`,
			)
			.bind(scopes, grant.id, grant.scopes)
			.first<{ id: string }>()
		if (updated) return true
	}
	throw new Error(
		'Package app OAuth grant changed repeatedly while updating scopes',
	)
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
