import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { loadAdminUserOauthGrants } from './user-oauth-grants.ts'

const stableUserId = testStableUserIdFromEmail('grants@example.com')
const teamOrgId = testStableUserIdFromEmail('team@example.com')

vi.mock('#worker/oauth-helpers.ts', () => ({
	resolveOAuthHelpers: async () => ({
		async listUserGrants() {
			return {
				items: [
					{
						id: 'grant-personal',
						clientId: 'client-a',
						scope: ['profile'],
						createdAt: 1_700_000_000,
						metadata: {},
					},
					{
						id: 'grant-team',
						clientId: 'client-b',
						scope: ['profile'],
						createdAt: 1_700_000_100,
						metadata: { orgId: teamOrgId },
					},
				],
			}
		},
	}),
}))

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('grants', 'grants@example.com', 'hash', ?, '2026-01-01', '2026-01-01')`,
		)
		.run(stableUserId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'grants', 'free', '2026-01-01', '2026-01-01')`,
		)
		.run(stableUserId)
	return createD1FromSqlite(sqlite)
}

test('loadAdminUserOauthGrants lists bound org ids for a person (#3535)', async () => {
	const db = createDb()
	const meter = createInMemoryUserMeterEnv()
	const result = await loadAdminUserOauthGrants({
		env: { APP_DB: db, ...meter.env } as unknown as Env,
		target: { email: 'grants@example.com' },
	})
	expect(result).toMatchObject({
		stableUserId,
		username: 'grants',
		email: 'grants@example.com',
		listingFailed: false,
	})
	expect(result?.grants).toEqual([
		expect.objectContaining({
			grantId: 'grant-personal',
			clientId: 'client-a',
			boundOrgId: null,
			createdAt: '2023-11-14T22:13:20.000Z',
		}),
		expect.objectContaining({
			grantId: 'grant-team',
			clientId: 'client-b',
			boundOrgId: teamOrgId,
		}),
	])
})

test('loadAdminUserOauthGrants returns null for an unknown person', async () => {
	const db = createDb()
	expect(
		await loadAdminUserOauthGrants({
			env: {
				APP_DB: db,
				...createInMemoryUserMeterEnv().env,
			} as unknown as Env,
			target: { email: 'missing@example.com' },
		}),
	).toBeNull()
})
