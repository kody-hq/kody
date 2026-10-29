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
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import {
	loadOrgProfileVisibility,
	loadOwnerProfilePublic,
	loadTeamOrgProfileBySlug,
} from './org-public-profile.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({
		db,
		columns: ['bio', 'avatar_key', 'profile_visibility'],
	})
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
			audit: createTestOrgAuditWriter(),
			displayName: 'Zeta Company',
			slug: 'Zeta-Co',
		}),
	).toEqual({
		ok: true,
		slug: 'zeta-co',
		displayName: 'Zeta Company',
		profileVisibility: 'public',
	})

	const renamed = await updateOrgProfile(db, {
		orgId: org!.id,
		audit: createTestOrgAuditWriter(),
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
			audit: createTestOrgAuditWriter(),
			displayName: 'Ada Org',
			slug: 'ada-renamed',
		}),
	).toMatchObject({ ok: false, code: 'personal' })

	expect(
		await updateOrgProfile(db, {
			orgId: team!.id,
			audit: createTestOrgAuditWriter(),
			slug: 'ada',
		}),
	).toMatchObject({ ok: false, code: 'validation' })

	expect(
		await updateOrgProfile(db, {
			orgId: team!.id,
			audit: createTestOrgAuditWriter(),
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
			audit: createTestOrgAuditWriter(),
			displayName: 'Kody',
		}),
	).toEqual({
		ok: true,
		slug: 'kody',
		displayName: 'Kody',
		profileVisibility: 'public',
	})
})

async function createTeamOrg(
	db: D1Database,
	input: { slug: string; profileVisibility?: 'public' | 'private' },
	audit = createTestOrgAuditWriter(),
) {
	const owner = testStableUserIdFromEmail(`${input.slug}-owner@example.com`)
	const created = await createOrganization(db, env, {
		personId: owner,
		audit,
		slug: input.slug,
		displayName: 'Acme Team',
		...(input.profileVisibility
			? { profileVisibility: input.profileVisibility }
			: {}),
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id, profile_visibility FROM orgs WHERE slug = ?`)
		.bind(input.slug)
		.first<{ id: string; profile_visibility: string }>()
	return org!
}

async function auditRows(auditDb: D1Database) {
	const { results } = await auditDb
		.prepare(
			`SELECT action, details_json FROM org_audit_events ORDER BY created_at, rowid`,
		)
		.all<{ action: string; details_json: string | null }>()
	return results.map((row) => ({
		action: row.action,
		details: row.details_json ? JSON.parse(row.details_json) : null,
	}))
}

test('team orgs are created public by default, can be created private, and record the choice', async () => {
	const db = await createDb()
	const auditDb = createAuditTestDb()
	const audit = createTestOrgAuditWriter({ db: auditDb })
	const open = await createTeamOrg(db, { slug: 'acme-team' }, audit)
	expect(open.profile_visibility).toBe('public')
	const closed = await createTeamOrg(
		db,
		{ slug: 'acme-private', profileVisibility: 'private' },
		audit,
	)
	expect(closed.profile_visibility).toBe('private')
	expect(
		(await auditRows(auditDb)).filter((row) => row.action === 'org.created'),
	).toEqual([
		{
			action: 'org.created',
			details: { slug: 'acme-team', profile_visibility: 'public' },
		},
		{
			action: 'org.created',
			details: { slug: 'acme-private', profile_visibility: 'private' },
		},
	])
})

test('updateOrgProfile toggles page visibility and audits only real changes', async () => {
	const db = await createDb()
	const org = await createTeamOrg(db, { slug: 'acme-team' })
	const auditDb = createAuditTestDb()
	const audit = createTestOrgAuditWriter({ db: auditDb })

	expect(
		await updateOrgProfile(db, {
			orgId: org.id,
			profileVisibility: 'private',
			audit,
		}),
	).toMatchObject({ ok: true, profileVisibility: 'private' })
	expect(await loadOrgProfileVisibility(db, org.id)).toBe('private')
	// Same value again, and a name-only edit, keep the stored choice silently.
	await updateOrgProfile(db, {
		orgId: org.id,
		profileVisibility: 'private',
		audit,
	})
	expect(
		await updateOrgProfile(db, {
			orgId: org.id,
			displayName: 'Acme Renamed',
			audit,
		}),
	).toMatchObject({ ok: true, profileVisibility: 'private' })
	await updateOrgProfile(db, {
		orgId: org.id,
		profileVisibility: 'public',
		audit,
	})

	expect(await auditRows(auditDb)).toEqual([
		{
			action: 'org.profile_visibility_changed',
			details: {
				profile_visibility: 'private',
				previous_profile_visibility: 'public',
			},
		},
		{
			action: 'org.profile_visibility_changed',
			details: {
				profile_visibility: 'public',
				previous_profile_visibility: 'private',
			},
		},
	])
})

test('updateOrgProfile refuses visibility changes on a personal org', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await insertPerson(db, { id: 1, personId: ada, username: 'ada' })
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada' })
	expect(
		await updateOrgProfile(db, {
			orgId: ada,
			profileVisibility: 'private',
			audit: createTestOrgAuditWriter(),
		}),
	).toMatchObject({ ok: false, code: 'personal' })
	expect(await loadOrgProfileVisibility(db, ada)).toBe('public')
})

test('team org page lookup skips personal, soft-deleted, and suspended orgs', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await insertPerson(db, { id: 1, personId: ada, username: 'ada' })
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada' })
	const live = await createTeamOrg(db, { slug: 'acme-team' })
	await createTeamOrg(db, { slug: 'acme-gone' })
	await createTeamOrg(db, { slug: 'acme-held' })
	await db
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE slug = 'acme-gone'`)
		.bind('2026-10-01T00:00:00.000Z')
		.run()
	await db
		.prepare(`UPDATE orgs SET suspended_at = ? WHERE slug = 'acme-held'`)
		.bind('2026-10-01T00:00:00.000Z')
		.run()

	expect(await loadTeamOrgProfileBySlug(db, 'Acme-Team')).toMatchObject({
		id: live.id,
		slug: 'acme-team',
		display_name: 'Acme Team',
		profile_visibility: 'public',
	})
	expect(await loadTeamOrgProfileBySlug(db, 'ada')).toBeNull()
	expect(await loadTeamOrgProfileBySlug(db, 'acme-gone')).toBeNull()
	expect(await loadTeamOrgProfileBySlug(db, 'acme-held')).toBeNull()
	expect(await loadTeamOrgProfileBySlug(db, 'nobody-here')).toBeNull()
})

test('package owner links follow the person profile, else the team org visibility', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const bea = testStableUserIdFromEmail('bea@example.com')
	await insertPerson(db, { id: 1, personId: ada, username: 'ada' })
	await insertPerson(db, { id: 2, personId: bea, username: 'bea' })
	await db
		.prepare(`UPDATE users SET profile_visibility = 'private' WHERE id = 2`)
		.run()
	await createTeamOrg(db, { slug: 'acme-team' })
	await createTeamOrg(db, {
		slug: 'acme-private',
		profileVisibility: 'private',
	})

	expect(await loadOwnerProfilePublic(db, 'ada')).toBe(true)
	expect(await loadOwnerProfilePublic(db, 'bea')).toBe(false)
	expect(await loadOwnerProfilePublic(db, 'acme-team')).toBe(true)
	expect(await loadOwnerProfilePublic(db, 'acme-private')).toBe(false)
	expect(await loadOwnerProfilePublic(db, 'nobody-here')).toBe(false)
})

function racingDb(
	db: D1Database,
	orgId: string,
	concurrent: 'public' | 'private',
) {
	const flip = () =>
		db
			.prepare(`UPDATE orgs SET profile_visibility = ? WHERE id = ?`)
			.bind(concurrent, orgId)
			.run()
	return new Proxy(db, {
		get(target, key) {
			if (key === 'batch')
				return async (statements: Array<D1PreparedStatement>) => {
					await flip()
					return target.batch(statements)
				}
			if (key !== 'prepare') return Reflect.get(target, key)
			return (sql: string) => {
				const statement = target.prepare(sql)
				if (!sql.trimStart().startsWith('UPDATE orgs')) return statement
				return {
					bind: (...values: Array<unknown>) => {
						const bound = statement.bind(...values)
						return Object.assign(Object.create(bound), {
							async run() {
								await flip()
								return bound.run()
							},
						})
					},
				}
			}
		},
	}) as D1Database
}

test('updateOrgProfile reports a conflict instead of overwriting a concurrent visibility change', async () => {
	const db = await createDb()
	const auditDb = createAuditTestDb()
	const audit = createTestOrgAuditWriter({ db: auditDb })

	// Audited change path: public -> private loses to a concurrent flip.
	const changing = await createTeamOrg(db, { slug: 'acme-team' })
	expect(
		await updateOrgProfile(racingDb(db, changing.id, 'private'), {
			orgId: changing.id,
			profileVisibility: 'private',
			audit,
		}),
	).toMatchObject({ ok: false, code: 'conflict' })
	expect(await loadOrgProfileVisibility(db, changing.id)).toBe('private')

	// Same-value path: a stale "public" must not undo a concurrent "private".
	const same = await createTeamOrg(db, { slug: 'acme-other' })
	expect(
		await updateOrgProfile(racingDb(db, same.id, 'private'), {
			orgId: same.id,
			profileVisibility: 'public',
			audit,
		}),
	).toMatchObject({ ok: false, code: 'conflict' })
	expect(await loadOrgProfileVisibility(db, same.id)).toBe('private')

	expect(
		(await auditRows(auditDb)).filter(
			(row) => row.action === 'org.profile_visibility_changed',
		),
	).toEqual([])
})
