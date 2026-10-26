import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { runWithRequestContext } from '#worker/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { isOrgBindingMembershipQuery } from '#worker/test-support/org-binding-query.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg } from './provision.ts'
import {
	countPendingInvitesForPerson,
	listOrganizationsForPerson,
	listPendingInvitesForPerson,
	listOrgsForPerson,
	loadOrgBindingForOrg,
	loadOrgBindingForPerson,
	loadOrgBindingForSlug,
	PersonalOrgBindingMissingError,
} from './repo.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb(options?: { queries?: Array<string> }) {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite, options)
	await ensureUsersTestSchema({ db })
	await ensureOrgsTestSchema(db)
	sqlite.exec(
		`CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			kody_id TEXT,
			user_id TEXT,
			deleted_at TEXT
		)`,
	)
	return db
}

async function insertPerson(
	db: D1Database,
	input: {
		stableUserId: string
		username: string
		email: string
		personalOrgId?: string
	},
) {
	const personalOrgId = input.personalOrgId ?? input.stableUserId
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (?, ?, 'hash', ?, ?)`,
		)
		.bind(input.username, input.email, input.stableUserId, personalOrgId)
		.run()
}

test('loadOrgBindingForPerson throws when personal org membership is missing', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail(
		'missing-membership@example.com',
	)
	await insertPerson(db, {
		stableUserId,
		username: 'missing',
		email: 'missing-membership@example.com',
	})
	await expect(loadOrgBindingForPerson(db, stableUserId)).rejects.toThrow(
		PersonalOrgBindingMissingError,
	)
})

test('loadOrgBindingForPerson returns personal org slug and owner role', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('ada@example.com')
	await insertPerson(db, {
		stableUserId,
		username: 'ada',
		email: 'ada@example.com',
	})
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})

	expect(await loadOrgBindingForPerson(db, stableUserId)).toEqual({
		org: { id: stableUserId, slug: 'ada' },
		role: 'owner',
	})
})

test('loadOrgBindingForOrg requires membership or a live grant', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await insertPerson(db, {
		stableUserId: ada,
		username: 'ada',
		email: 'ada@example.com',
	})
	await insertPerson(db, {
		stableUserId: gus,
		username: 'gus',
		email: 'gus@example.com',
	})
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

	expect(await loadOrgBindingForOrg(db, ada, ada)).toEqual({
		org: { id: ada, slug: 'ada' },
		role: 'owner',
	})
	expect(await loadOrgBindingForOrg(db, ada, gus)).toBeNull()

	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.bind(
			'grant-1',
			gus,
			ada,
			gus,
			'2026-01-04T00:00:00.000Z',
			'2026-01-04T00:00:00.000Z',
		)
		.run()

	expect(await loadOrgBindingForOrg(db, ada, gus)).toEqual({
		org: { id: gus, slug: 'gus' },
		role: null,
	})
})

test('loadOrgBindingForOrg hits D1 once per (personId, orgId) within a request', async () => {
	const queries: Array<string> = []
	const db = await createDb({ queries })
	const ada = testStableUserIdFromEmail('ada-memo@example.com')
	const gus = testStableUserIdFromEmail('gus-memo@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-memo',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus-memo',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	queries.length = 0

	const membershipPrepares = () =>
		queries.filter((query) =>
			isOrgBindingMembershipQuery(
				query.replace(/\s+/g, ' ').trim().toLowerCase(),
			),
		).length

	const request = new Request(
		'https://kody.test/profiles/ada/packages/demo/files.json',
	)
	const expected = {
		org: { id: ada, slug: 'ada-memo' },
		role: 'owner' as const,
	}
	// Same fan-out shape as loadPackagePageUncached: one read check, then four
	// manage/publish/delete/owner checks in parallel (KODY-98).
	const results = await runWithRequestContext(request, () =>
		Promise.all([
			loadOrgBindingForOrg(db, ada, ada),
			loadOrgBindingForOrg(db, ada, ada),
			loadOrgBindingForOrg(db, ada, ada),
			loadOrgBindingForOrg(db, ada, ada),
			loadOrgBindingForOrg(db, ada, ada),
		]),
	)
	expect(results).toEqual([expected, expected, expected, expected, expected])
	expect(membershipPrepares()).toBe(1)

	const other = await runWithRequestContext(request, () =>
		loadOrgBindingForOrg(db, ada, gus),
	)
	expect(other).toBeNull()
	expect(membershipPrepares()).toBe(2)

	await expect(loadOrgBindingForOrg(db, ada, ada)).resolves.toEqual(expected)
	await expect(loadOrgBindingForOrg(db, ada, ada)).resolves.toEqual(expected)
	expect(membershipPrepares()).toBe(4)
})

test('listOrgsForPerson unions memberships and live grant orgs', async () => {
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
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.bind(
			'grant-1',
			gus,
			ada,
			gus,
			'2026-01-04T00:00:00.000Z',
			'2026-01-04T00:00:00.000Z',
		)
		.run()

	const orgs = await listOrgsForPerson(db, ada)
	expect(orgs.map((org) => ({ id: org.id, role: org.role }))).toEqual([
		{ id: ada, role: 'owner' },
		{ id: gus, role: null },
	])
})

test('listOrganizationsForPerson marks a minted personal org id as personal', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('nova@example.com')
	const personalOrgId = 'd'.repeat(64)
	await insertPerson(db, {
		stableUserId,
		username: 'nova',
		email: 'nova@example.com',
		personalOrgId,
	})
	await provisionPersonalOrg(db, {
		stableUserId,
		orgId: personalOrgId,
		username: 'nova',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const teamOrgId = 'e'.repeat(64)
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'alpha', 'Alpha', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(teamOrgId)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(teamOrgId, stableUserId)
		.run()

	const listed = await listOrganizationsForPerson(db, stableUserId)
	expect(
		listed.map((org) => ({ slug: org.slug, personal: org.personal })),
	).toEqual([
		{ slug: 'nova', personal: true },
		{ slug: 'alpha', personal: false },
	])
})

test('listOrganizationsForPerson puts the signup organization first and includes grant-only orgs', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const otherId = 'b'.repeat(64)
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'zeta', 'Zeta', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(otherId)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(otherId, stableUserId)
		.run()
	const grantOrgId = 'c'.repeat(64)
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'acme', 'Acme', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(grantOrgId)
		.run()
	await db
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-1', ?, 'package', 'pkg-1', 'user', ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(grantOrgId, stableUserId, stableUserId)
		.run()

	const listed = await listOrganizationsForPerson(db, stableUserId)
	expect(listed.map((org) => org.slug)).toEqual(['ada', 'acme', 'zeta'])
	expect(listed.find((org) => org.slug === 'ada')).toMatchObject({
		role: 'owner',
		personal: true,
	})
	expect(listed.find((org) => org.slug === 'acme')).toMatchObject({
		role: null,
		personal: false,
	})
	expect(await loadOrgBindingForSlug(db, stableUserId, 'acme')).toEqual({
		org: { id: grantOrgId, slug: 'acme' },
		role: null,
	})
	expect(await loadOrgBindingForSlug(db, stableUserId, 'missing')).toBeNull()

	await db
		.prepare(
			`INSERT INTO invites (
			   id, org_id, kind, invitee_email, token_hash, status,
			   invited_by_user_id, expires_at, created_at
			 ) VALUES (
			   'invite-1', ?, 'membership', 'ada@example.com', 'hash-1', 'pending',
			   ?, '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
			 )`,
		)
		.bind(otherId, stableUserId)
		.run()
	expect(
		await countPendingInvitesForPerson(db, {
			email: 'Ada@Example.com',
			username: 'ada',
			now: '2026-02-01T00:00:00.000Z',
		}),
	).toBe(1)
	expect(
		await listPendingInvitesForPerson(db, {
			email: 'Ada@Example.com',
			username: 'ada',
			now: '2026-02-01T00:00:00.000Z',
		}),
	).toEqual([
		{
			id: 'invite-1',
			orgSlug: 'zeta',
			orgDisplayName: 'Zeta',
			orgPersonal: false,
			kind: 'membership',
			role: null,
			resourceType: null,
			preset: null,
			packageName: null,
			expiresAt: '2099-01-01T00:00:00.000Z',
		},
	])
})

test('pending invites exclude deleted and suspended orgs', async () => {
	const db = await createDb()
	const inviterId = 'a'.repeat(64)
	const orgs = [
		{ id: 'b'.repeat(64), slug: 'live', deletedAt: null, suspendedAt: null },
		{
			id: 'c'.repeat(64),
			slug: 'gone',
			deletedAt: '2026-01-05T00:00:00.000Z',
			suspendedAt: null,
		},
		{
			id: 'd'.repeat(64),
			slug: 'paused',
			deletedAt: null,
			suspendedAt: '2026-01-05T00:00:00.000Z',
		},
	]
	for (const org of orgs) {
		await db
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, deleted_at, suspended_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
			)
			.bind(org.id, org.slug, org.slug, org.deletedAt, org.suspendedAt)
			.run()
		await db
			.prepare(
				`INSERT INTO invites (
				   id, org_id, kind, invitee_email, token_hash, status,
				   invited_by_user_id, expires_at, created_at
				 ) VALUES (
				   ?, ?, 'membership', 'ada@example.com', ?, 'pending',
				   ?, '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
				 )`,
			)
			.bind(`invite-${org.slug}`, org.id, `hash-${org.slug}`, inviterId)
			.run()
	}
	const query = {
		email: 'ada@example.com',
		username: 'ada',
		now: '2026-02-01T00:00:00.000Z',
	}
	expect(await countPendingInvitesForPerson(db, query)).toBe(1)
	expect(
		(await listPendingInvitesForPerson(db, query)).map((i) => i.orgSlug),
	).toEqual(['live'])
})

test('loadOrgBindingForOrg and listOrgsForPerson skip deleted and suspended orgs', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const orgs = [
		{ id: 'b'.repeat(64), slug: 'live', deletedAt: null, suspendedAt: null },
		{
			id: 'c'.repeat(64),
			slug: 'gone',
			deletedAt: '2026-01-05T00:00:00.000Z',
			suspendedAt: null,
		},
		{
			id: 'd'.repeat(64),
			slug: 'paused',
			deletedAt: null,
			suspendedAt: '2026-01-05T00:00:00.000Z',
		},
	]
	for (const org of orgs) {
		await db
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, deleted_at, suspended_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
			)
			.bind(org.id, org.slug, org.slug, org.deletedAt, org.suspendedAt)
			.run()
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'member', '2026-01-02T00:00:00.000Z')`,
			)
			.bind(org.id, ada)
			.run()
	}
	const grantOrgs = [
		{ id: 'e'.repeat(64), slug: 'live-grant', suspendedAt: null },
		{
			id: 'f'.repeat(64),
			slug: 'paused-grant',
			suspendedAt: '2026-01-05T00:00:00.000Z',
		},
	]
	for (const org of grantOrgs) {
		await db
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, suspended_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
			)
			.bind(org.id, org.slug, org.slug, org.suspendedAt)
			.run()
		await db
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					preset, created_by_user_id, created_at, updated_at, deleted_at
				) VALUES (?, ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?, NULL)`,
			)
			.bind(
				`grant-${org.slug}`,
				org.id,
				ada,
				org.id,
				'2026-01-04T00:00:00.000Z',
				'2026-01-04T00:00:00.000Z',
			)
			.run()
	}

	expect(await loadOrgBindingForOrg(db, ada, 'b'.repeat(64))).toEqual({
		org: { id: 'b'.repeat(64), slug: 'live' },
		role: 'member',
	})
	expect(await loadOrgBindingForOrg(db, ada, 'c'.repeat(64))).toBeNull()
	expect(await loadOrgBindingForOrg(db, ada, 'd'.repeat(64))).toBeNull()
	expect(await loadOrgBindingForOrg(db, ada, 'e'.repeat(64))).toEqual({
		org: { id: 'e'.repeat(64), slug: 'live-grant' },
		role: null,
	})
	expect(await loadOrgBindingForOrg(db, ada, 'f'.repeat(64))).toBeNull()

	const listed = await listOrgsForPerson(db, ada)
	expect(listed.map((org) => org.slug)).toEqual(['ada', 'live', 'live-grant'])
})

test('loadOrgBindingForOrg and listOrgsForPerson include orgs reached through a team grant', async () => {
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
	const ts = '2026-01-04T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO teams (
				id, org_id, slug, name, created_by_user_id, created_at, updated_at
			) VALUES ('team-1', ?, 'eng', 'Eng', ?, ?, ?)`,
		)
		.bind(gus, gus, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-1', ?, ?)`,
		)
		.bind(ada, ts)
		.run()

	expect(await loadOrgBindingForOrg(db, ada, gus)).toBeNull()

	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES ('grant-team', ?, 'package', 'pkg-1', 'team', 'team-1', 'use', ?, ?, ?, NULL)`,
		)
		.bind(gus, gus, ts, ts)
		.run()

	expect(await loadOrgBindingForOrg(db, ada, gus)).toEqual({
		org: { id: gus, slug: 'gus' },
		role: null,
	})
	expect(
		(await listOrgsForPerson(db, ada)).map((org) => ({
			id: org.id,
			role: org.role,
		})),
	).toEqual([
		{ id: ada, role: 'owner' },
		{ id: gus, role: null },
	])

	await db
		.prepare(`UPDATE team_members SET deleted_at = ? WHERE team_id = 'team-1'`)
		.bind(ts)
		.run()
	expect(await loadOrgBindingForOrg(db, ada, gus)).toBeNull()
	expect((await listOrgsForPerson(db, ada)).map((org) => org.id)).toEqual([ada])
})
