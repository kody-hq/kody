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

export async function findPackageAppGrantCredentialMapping(input: {
	db: D1Database
	grantId: string
	needKey: string
}): Promise<Array<string>> {
	const row = await input.db
		.prepare(
			`SELECT credential_ids_json
			 FROM package_app_grant_credential_mappings
			 WHERE grant_id = ? AND need_key = ?`,
		)
		.bind(input.grantId, input.needKey)
		.first<{ credential_ids_json: string }>()
	if (!row) return []
	try {
		const parsed: unknown = JSON.parse(row.credential_ids_json)
		if (!Array.isArray(parsed)) return []
		return [
			...new Set(
				parsed.filter(
					(id): id is string => typeof id === 'string' && id.length > 0,
				),
			),
		]
	} catch {
		return []
	}
}

export async function hasCredentialMappingOutsidePackageAppRevoke(input: {
	db: D1Database
	credentialId: string
	grantId: string
	personId: string
	personOrgId: string
	needKey?: string | null
}): Promise<boolean> {
	const otherGrantMapping = await input.db
		.prepare(
			`SELECT 1 AS found
			 FROM package_app_grant_credential_mappings AS mapping
			 JOIN package_app_oauth_grants AS owner_grant
			   ON owner_grant.id = mapping.grant_id,
			      json_each(mapping.credential_ids_json) AS credential
			 WHERE owner_grant.person_id = ?
			   AND credential.value = ?
			   AND NOT (
			     mapping.grant_id = ?
			     AND (? IS NULL OR mapping.need_key = ?)
			   )
			 LIMIT 1`,
		)
		.bind(
			input.personId,
			input.credentialId,
			input.grantId,
			input.needKey ?? null,
			input.needKey ?? null,
		)
		.first<{ found: number }>()
	if (otherGrantMapping) return true
	const otherCredentialMapping = await input.db
		.prepare(
			`SELECT 1 AS found
			 FROM credential_mappings AS mapping,
			      json_each(mapping.credential_ids_json) AS credential
			 WHERE credential.value = ?
			   AND (
			     mapping.org_id = ?
			     OR mapping.person_user_id = ?
			   )
			 LIMIT 1`,
		)
		.bind(input.credentialId, input.personOrgId, input.personId)
		.first<{ found: number }>()
	return Boolean(otherCredentialMapping)
}

export async function upsertPackageAppGrantCredentialMapping(input: {
	db: D1Database
	grantId: string
	needKey: string
	credentialIds: ReadonlyArray<string>
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	await input.db
		.prepare(
			`INSERT INTO package_app_grant_credential_mappings
			 (grant_id, need_key, credential_ids_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(grant_id, need_key) DO UPDATE SET
			   credential_ids_json = excluded.credential_ids_json,
			   updated_at = excluded.updated_at`,
		)
		.bind(
			input.grantId,
			input.needKey,
			JSON.stringify([...new Set(input.credentialIds)]),
			now,
			now,
		)
		.run()
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

export async function upsertPackageAppOauthGrantWithCredentialMappings(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
	scopes: ReadonlyArray<PackageAppOauthScope>
	mappings: ReadonlyArray<{
		needKey: string
		credentialIds: ReadonlyArray<string>
	}>
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	for (
		let attempt = 0;
		attempt < maxPackageAppOauthGrantUpdateAttempts;
		attempt++
	) {
		const existing = await findLivePackageAppOauthGrantRow(input)
		const scopes = serializePackageAppOauthScopes([
			...(existing ? toGrant(existing).scopes : []),
			...input.scopes,
		])
		const statements = [
			existing
				? input.db
						.prepare(
							`UPDATE package_app_oauth_grants
							 SET scopes = ?
							 WHERE id = ? AND scopes = ? AND revoked_at IS NULL`,
						)
						.bind(scopes, existing.id, existing.scopes)
				: input.db
						.prepare(
							`INSERT INTO package_app_oauth_grants
							 (id, person_id, org_username, kody_id, scopes, created_at)
							 VALUES (?, ?, ?, ?, ?, ?)
							 ON CONFLICT DO NOTHING`,
						)
						.bind(
							crypto.randomUUID(),
							input.personId,
							input.orgUsername,
							input.kodyId,
							scopes,
							now,
						),
		]
		for (const mapping of input.mappings) {
			if (mapping.credentialIds.length === 0) {
				statements.push(
					input.db
						.prepare(
							`DELETE FROM package_app_grant_credential_mappings
							 WHERE need_key = ?
							   AND grant_id IN (
							     SELECT id FROM package_app_oauth_grants
							     WHERE person_id = ? AND org_username = ? AND kody_id = ?
							       AND scopes = ? AND revoked_at IS NULL
							   )`,
						)
						.bind(
							mapping.needKey,
							input.personId,
							input.orgUsername,
							input.kodyId,
							scopes,
						),
				)
				continue
			}
			statements.push(
				input.db
					.prepare(
						`INSERT INTO package_app_grant_credential_mappings
						 (grant_id, need_key, credential_ids_json, created_at, updated_at)
						 SELECT id, ?, ?, ?, ? FROM package_app_oauth_grants
						 WHERE person_id = ? AND org_username = ? AND kody_id = ?
						   AND scopes = ? AND revoked_at IS NULL
						 ON CONFLICT(grant_id, need_key) DO UPDATE SET
						   credential_ids_json = excluded.credential_ids_json,
						   updated_at = excluded.updated_at`,
					)
					.bind(
						mapping.needKey,
						JSON.stringify([...new Set(mapping.credentialIds)]),
						now,
						now,
						input.personId,
						input.orgUsername,
						input.kodyId,
						scopes,
					),
			)
		}
		await input.db.batch(statements)
		const current = await findLivePackageAppOauthGrantRow(input)
		if (current?.scopes === scopes) return
	}
	throw new Error(
		'Package app OAuth grant changed repeatedly while updating credential mappings',
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
	await input.db
		.prepare(
			`DELETE FROM package_app_grant_credential_mappings
			 WHERE grant_id IN (
			   SELECT id FROM package_app_oauth_grants
			   WHERE person_id = ? AND org_username = ? AND kody_id = ?
			     AND revoked_at IS NOT NULL
			 )`,
		)
		.bind(input.personId, input.orgUsername, input.kodyId)
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
		if (updated) {
			const needKey = scope.startsWith('need:') ? scope.slice(5) : null
			if (needKey) {
				await input.db
					.prepare(
						`DELETE FROM package_app_grant_credential_mappings
						 WHERE grant_id = ? AND need_key = ?`,
					)
					.bind(grant.id, needKey)
					.run()
			}
			return true
		}
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
