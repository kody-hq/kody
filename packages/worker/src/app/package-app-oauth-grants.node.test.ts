import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	findLivePackageAppOauthGrant,
	revokePackageAppOauthGrantScope,
	upsertPackageAppOauthGrant,
} from './package-app-oauth-grants.ts'

test('package app consent scopes merge and optional grants revoke independently', async () => {
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
		)`,
	)
	const db = createD1FromSqlite(sqlite)
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
	sqlite.close()
})
