import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createOrganization } from './create-organization.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import { updateOrgProfile } from './org-profile.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg } from './provision.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db })
	return db
}

async function insertPerson(
	db: D1Database,
	input: { id: number; personId: string; username: string },
) {
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (?, ?, ?, 'x', ?)`,
		)
		.bind(
			input.id,
			input.username,
			`${input.username}@example.com`,
			input.personId,
		)
		.run()
}

const env = {} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>

test('updateOrgProfile changes the display name and keeps the handle permanent', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const created = await createOrganization(db, env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'zeta-co',
		displayName: 'Zeta Co',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>()

	expect(
		await updateOrgProfile(db, {
			orgId: org!.id,
			displayName: 'Zeta Company',
			slug: 'Zeta-Co',
		}),
	).toEqual({ ok: true, slug: 'zeta-co', displayName: 'Zeta Company' })

	const renamed = await updateOrgProfile(db, {
		orgId: org!.id,
		displayName: 'Zeta Renamed',
		slug: 'zeta-company',
	})
	expect(renamed).toEqual({
		ok: false,
		code: 'validation',
		error:
			'Organization handles are permanent and cannot be changed. You can change the display name instead.',
	})
	expect(
		await db
			.prepare(`SELECT slug, display_name FROM orgs WHERE id = ?`)
			.bind(org!.id)
			.first(),
	).toEqual({ slug: 'zeta-co', display_name: 'Zeta Company' })
	expect(
		await db
			.prepare(`SELECT handle, org_id FROM handles WHERE org_id = ?`)
			.bind(org!.id)
			.all()
			.then((result) => result.results),
	).toEqual([{ handle: 'zeta-co', org_id: org!.id }])
})

test('updateOrgProfile refuses a personal org and rejects a different handle', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await insertPerson(db, { id: 1, personId: ada, username: 'ada' })
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const created = await createOrganization(db, env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'zeta',
		displayName: 'Zeta',
	})
	if (!created.ok) throw new Error(created.error)
	const team = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta'`)
		.first<{ id: string }>()

	expect(
		await updateOrgProfile(db, {
			orgId: ada,
			displayName: 'Ada Org',
			slug: 'ada-renamed',
		}),
	).toMatchObject({ ok: false, code: 'personal' })

	expect(
		await updateOrgProfile(db, {
			orgId: team!.id,
			slug: 'ada',
		}),
	).toMatchObject({ ok: false, code: 'validation' })

	expect(
		await updateOrgProfile(db, {
			orgId: team!.id,
			slug: 'no',
		}),
	).toMatchObject({ ok: false, code: 'validation' })
})

test('updateOrgProfile allows a former platform org with a soft-deleted founding membership', async () => {
	const db = await createDb()
	const platformId = testStableUserIdFromEmail('kody@platform.example')
	const ownerId = testStableUserIdFromEmail('kent@example.com')
	const now = '2026-01-02T00:00:00.000Z'
	await insertPerson(db, { id: 2, personId: ownerId, username: 'kent' })
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'kody', NULL, ?, ?)`,
		)
		.bind(platformId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', ?, ?)`,
		)
		.bind(platformId, platformId, now, '2026-10-10T00:00:00.000Z')
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('kody', ?, ?)`,
		)
		.bind(platformId, now)
		.run()

	expect(await isPersonalOrg(db, platformId)).toBe(false)
	expect(
		await updateOrgProfile(db, {
			orgId: platformId,
			displayName: 'Kody',
		}),
	).toEqual({ ok: true, slug: 'kody', displayName: 'Kody' })
})
