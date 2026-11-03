import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { loadOrgBindingFromGrantProps } from './grant-binding.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg } from './provision.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

test('loadOrgBindingFromGrantProps uses stamped orgId and fails closed without it', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus',
		createdAt: '2026-01-02T00:00:00.000Z',
	})

	expect(
		await loadOrgBindingFromGrantProps({
			db,
			personId: ada,
			grantProps: { orgId: ada, userId: ada },
		}),
	).toEqual({
		org: { id: ada, slug: 'ada' },
		role: 'owner',
	})
	expect(
		await loadOrgBindingFromGrantProps({
			db,
			personId: ada,
			grantProps: { userId: ada },
		}),
	).toBeNull()
	expect(
		await loadOrgBindingFromGrantProps({
			db,
			personId: ada,
			grantProps: { orgId: gus, userId: ada },
		}),
	).toBeNull()
	expect(
		await loadOrgBindingFromGrantProps({
			db,
			personId: ada,
			grantProps: { userId: gus },
		}),
	).toBeNull()
})
