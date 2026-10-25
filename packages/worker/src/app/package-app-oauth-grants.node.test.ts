import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	findPackageAppGrantCredentialMapping,
	findLivePackageAppOauthGrant,
	revokePackageAppOauthGrantsForPersonApp,
	revokePackageAppOauthGrantScope,
	upsertPackageAppOauthGrant,
	upsertPackageAppOauthGrantWithCredentialMappings,
	upsertPackageAppGrantCredentialMapping,
} from './package-app-oauth-grants.ts'

function createGrantDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE package_app_oauth_grants (
			id TEXT PRIMARY KEY NOT NULL,
			person_id TEXT NOT NULL,
			org_username TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			scopes TEXT NOT NULL,
			created_at TEXT NOT NULL,
			revoked_at TEXT,
			last_used_at TEXT
		);
		CREATE UNIQUE INDEX package_app_oauth_grants_person_app_live_idx
			ON package_app_oauth_grants (person_id, org_username, kody_id)
			WHERE revoked_at IS NULL;
		CREATE TABLE package_app_grant_credential_mappings (
			grant_id TEXT NOT NULL,
			need_key TEXT NOT NULL,
			credential_ids_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (grant_id, need_key)
		)`,
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function raceFirstScopeUpdate(
	db: D1Database,
	beforeUpdate: () => void,
): D1Database {
	let pending = true
	return {
		prepare(query: string) {
			const statement = db.prepare(query)
			if (
				!query.includes('UPDATE package_app_oauth_grants') ||
				!query.includes('RETURNING id')
			) {
				return statement
			}
			return {
				...statement,
				bind(...values: Array<unknown>) {
					const bound = statement.bind(...values)
					return {
						...bound,
						async first<T>() {
							if (pending) {
								pending = false
								beforeUpdate()
							}
							return bound.first<T>()
						},
					}
				},
			}
		},
		batch: db.batch.bind(db),
		exec: db.exec.bind(db),
	} as unknown as D1Database
}

test('package app consent scopes merge and optional grants revoke independently', async () => {
	const { sqlite, db } = createGrantDatabase()
	const target = {
		db,
		personId: 'person-a',
		orgUsername: 'acme',
		kodyId: 'calendar',
	}

	const grantId = await upsertPackageAppOauthGrant({
		...target,
		scopes: ['profile', 'email'],
	})
	await upsertPackageAppGrantCredentialMapping({
		db,
		grantId,
		needKey: 'calendar',
		credentialIds: ['credential-a'],
	})
	await upsertPackageAppOauthGrant({
		...target,
		scopes: ['profile', 'need:calendar'],
	})
	await expect(findLivePackageAppOauthGrant(target)).resolves.toMatchObject({
		scopes: ['email', 'need:calendar', 'profile'],
	})

	await expect(
		revokePackageAppOauthGrantScope({ ...target, scope: 'email' }),
	).resolves.toBe(true)
	await expect(
		revokePackageAppOauthGrantScope({ ...target, scope: 'profile' }),
	).resolves.toBe(false)
	await expect(findLivePackageAppOauthGrant(target)).resolves.toMatchObject({
		scopes: ['need:calendar', 'profile'],
	})
	await expect(
		findPackageAppGrantCredentialMapping({
			db,
			grantId,
			needKey: 'calendar',
		}),
	).resolves.toEqual(['credential-a'])
	sqlite.close()
})

test('package app consent batches grant scope and credential mapping updates', async () => {
	const { sqlite, db } = createGrantDatabase()
	const target = {
		db,
		personId: 'person-a',
		orgUsername: 'acme',
		kodyId: 'calendar',
	}

	await upsertPackageAppOauthGrantWithCredentialMappings({
		...target,
		scopes: ['profile', 'need:calendar'],
		mappings: [{ needKey: 'calendar', credentialIds: ['credential-a'] }],
	})
	const grant = await findLivePackageAppOauthGrant(target)
	expect(grant?.scopes).toEqual(['need:calendar', 'profile'])
	await expect(
		findPackageAppGrantCredentialMapping({
			db,
			grantId: grant!.id,
			needKey: 'calendar',
		}),
	).resolves.toEqual(['credential-a'])

	await upsertPackageAppOauthGrantWithCredentialMappings({
		...target,
		scopes: ['profile', 'email'],
		mappings: [{ needKey: 'calendar', credentialIds: [] }],
	})
	await expect(findLivePackageAppOauthGrant(target)).resolves.toMatchObject({
		scopes: ['email', 'need:calendar', 'profile'],
	})
	await expect(
		findPackageAppGrantCredentialMapping({
			db,
			grantId: grant!.id,
			needKey: 'calendar',
		}),
	).resolves.toEqual([])
	sqlite.close()
})

test('grant scope upserts retry after concurrent revocation', async () => {
	const { sqlite, db } = createGrantDatabase()
	const target = {
		db,
		personId: 'person-a',
		orgUsername: 'acme',
		kodyId: 'calendar',
	}
	await upsertPackageAppOauthGrant({
		...target,
		scopes: ['profile', 'email'],
	})
	const existing = await findLivePackageAppOauthGrant(target)
	expect(existing).not.toBeNull()
	const racingDb = raceFirstScopeUpdate(db, () => {
		sqlite
			.prepare(`UPDATE package_app_oauth_grants SET scopes = ? WHERE id = ?`)
			.run('profile', existing!.id)
	})

	await upsertPackageAppOauthGrant({
		...target,
		db: racingDb,
		scopes: ['profile', 'need:calendar'],
	})

	await expect(findLivePackageAppOauthGrant(target)).resolves.toMatchObject({
		scopes: ['need:calendar', 'profile'],
	})
	sqlite.close()
})

test('revoking a need scope or whole app grant deletes its credential mapping', async () => {
	const { sqlite, db } = createGrantDatabase()
	const target = {
		db,
		personId: 'person-a',
		orgUsername: 'acme',
		kodyId: 'calendar',
	}
	const grantId = await upsertPackageAppOauthGrant({
		...target,
		scopes: ['profile', 'need:calendar'],
	})
	await upsertPackageAppGrantCredentialMapping({
		db,
		grantId,
		needKey: 'calendar',
		credentialIds: ['credential-a'],
	})
	await revokePackageAppOauthGrantScope({
		...target,
		scope: 'need:calendar',
	})
	await expect(
		findPackageAppGrantCredentialMapping({ db, grantId, needKey: 'calendar' }),
	).resolves.toEqual([])
	const nextGrantId = await upsertPackageAppOauthGrant({
		...target,
		scopes: ['profile', 'need:calendar'],
	})
	await upsertPackageAppGrantCredentialMapping({
		db,
		grantId: nextGrantId,
		needKey: 'calendar',
		credentialIds: ['credential-b'],
	})
	await revokePackageAppOauthGrantsForPersonApp(target)
	await expect(
		findPackageAppGrantCredentialMapping({
			db,
			grantId: nextGrantId,
			needKey: 'calendar',
		}),
	).resolves.toEqual([])
	sqlite.close()
})

test('scope revocation retries after concurrent consent', async () => {
	const { sqlite, db } = createGrantDatabase()
	const target = {
		db,
		personId: 'person-b',
		orgUsername: 'acme',
		kodyId: 'calendar',
	}
	await upsertPackageAppOauthGrant({
		...target,
		scopes: ['profile', 'email'],
	})
	const existing = await findLivePackageAppOauthGrant(target)
	expect(existing).not.toBeNull()
	const racingDb = raceFirstScopeUpdate(db, () => {
		sqlite
			.prepare(`UPDATE package_app_oauth_grants SET scopes = ? WHERE id = ?`)
			.run('email need:calendar profile', existing!.id)
	})

	await expect(
		revokePackageAppOauthGrantScope({
			...target,
			db: racingDb,
			scope: 'email',
		}),
	).resolves.toBe(true)

	await expect(findLivePackageAppOauthGrant(target)).resolves.toMatchObject({
		scopes: ['need:calendar', 'profile'],
	})
	sqlite.close()
})
