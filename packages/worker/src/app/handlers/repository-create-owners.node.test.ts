import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	checkPermission,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { websiteCapabilityContext } from '#worker/app/website-capability.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	listOrganizationsForPerson,
	loadOrgBindingForSlug,
} from '#worker/orgs/repo.ts'
import { runWithRequestContext } from '#worker/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { loadRepositoryCreateOptions } from './repository-create.ts'

const now = '2026-11-18T00:00:00.000Z'
const personId = testStableUserIdFromEmail('jane@example.com')
const ownerId = testStableUserIdFromEmail('owner@example.com')

type Seed = { db: D1Database; sqlite: DatabaseSync; queries: Array<string> }

async function createSeed(): Promise<Seed> {
	const sqlite = new DatabaseSync(':memory:')
	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries, maxBindings: 100 })
	await ensureUsersTestSchema({ db })
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES ('jane', 'jane@example.com', 'hash', ?, ?)`,
		)
		.bind(personId, personId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: personId,
		username: 'jane',
		createdAt: now,
	})
	return { db, sqlite, queries }
}

function insertOrg(
	seed: Seed,
	slug: string,
	options: { suspended?: boolean; membersCanCreatePackages?: boolean } = {},
) {
	const id = `org-${slug}`
	seed.sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, suspended_at,
			   members_can_create_packages, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			slug,
			slug.toUpperCase(),
			options.suspended ? now : null,
			options.membersCanCreatePackages ? 1 : 0,
			now,
			now,
		)
	return id
}

function insertMembership(seed: Seed, orgId: string, role: string) {
	seed.sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(orgId, personId, role, now)
}

function insertOrgGrant(
	seed: Seed,
	orgId: string,
	subject: { type: 'user' | 'team'; id: string },
	options: { expiresAt?: string } = {},
) {
	const grantId = `grant-${orgId}-${subject.type}`
	seed.sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id,
			   subject_type, subject_id, created_by_user_id, created_at,
			   updated_at, expires_at)
			 VALUES (?, ?, 'org', ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			grantId,
			orgId,
			orgId,
			subject.type,
			subject.id,
			ownerId,
			now,
			now,
			options.expiresAt ?? null,
		)
	seed.sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES (?, 'package:create')`,
		)
		.run(grantId)
}

function insertTeamGrant(seed: Seed, orgId: string) {
	const teamId = `team-${orgId}`
	seed.sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES (?, ?, 'builders', 'Builders', ?, ?)`,
		)
		.run(teamId, orgId, now, now)
	seed.sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES (?, ?, ?)`,
		)
		.run(teamId, personId, now)
	insertOrgGrant(seed, orgId, { type: 'team', id: teamId })
}

/**
 * `copies` of each org shape: admin, member who may create, member who may
 * not, direct grant, team grant, expired grant, suspended member and
 * suspended grant.
 */
async function seedOrgs(copies: number) {
	const seed = await createSeed()
	for (let copy = 0; copy < copies; copy++) {
		insertMembership(seed, insertOrg(seed, `admin-${copy}`), 'admin')
		insertMembership(
			seed,
			insertOrg(seed, `builder-${copy}`, { membersCanCreatePackages: true }),
			'member',
		)
		insertMembership(seed, insertOrg(seed, `viewer-${copy}`), 'member')
		insertOrgGrant(seed, insertOrg(seed, `granted-${copy}`), {
			type: 'user',
			id: personId,
		})
		insertTeamGrant(seed, insertOrg(seed, `team-${copy}`))
		insertOrgGrant(
			seed,
			insertOrg(seed, `expired-${copy}`),
			{ type: 'user', id: personId },
			{ expiresAt: '2020-01-01T00:00:00.000Z' },
		)
		insertMembership(
			seed,
			insertOrg(seed, `suspended-${copy}`, { suspended: true }),
			'admin',
		)
		insertOrgGrant(
			seed,
			insertOrg(seed, `suspended-grant-${copy}`, { suspended: true }),
			{ type: 'user', id: personId },
		)
	}
	return seed
}

function caller(db: D1Database) {
	return {
		env: { APP_DB: db } as unknown as Env,
		request: new Request('https://kody.test/repositories'),
		user: {
			mcpUser: { userId: personId, email: 'jane@example.com' },
		} as unknown as Parameters<typeof loadRepositoryCreateOptions>[0]['user'],
	}
}

function inRequest<Result>(run: () => Promise<Result>) {
	return runWithRequestContext(
		new Request('https://kody.test/repositories'),
		run,
	)
}

/** The owners the page listed before batching: one binding and check per org. */
async function ownersCheckedOneByOne(db: D1Database) {
	const input = caller(db)
	const organizations = await listOrganizationsForPerson(db, personId)
	const owners = []
	for (const organization of organizations) {
		const binding = await loadOrgBindingForSlug(db, personId, organization.slug)
		if (!binding) continue
		const { request } = websiteCapabilityContext({
			...input,
			orgBinding: binding,
		}).callerContext
		if (!request) continue
		const access = await inRequest(() =>
			computeEffectivePermissions({ env: input.env, request }),
		)
		if (!checkPermission(access, 'package:create').allowed) continue
		owners.push({
			slug: organization.slug,
			displayName: organization.displayName,
			personal: organization.personal,
		})
	}
	return owners.sort((a, b) =>
		a.personal === b.personal
			? a.slug.localeCompare(b.slug)
			: a.personal
				? -1
				: 1,
	)
}

test('owner options keep visibility and package:create for every org shape', async () => {
	const seed = await seedOrgs(1)
	const expected = await ownersCheckedOneByOne(seed.db)
	const fresh = await seedOrgs(1)
	const options = await inRequest(() =>
		loadRepositoryCreateOptions(caller(fresh.db)),
	)
	expect(options).toEqual({ ok: true, owners: expected })
	expect(options).toEqual({
		ok: true,
		owners: [
			{ slug: 'jane', displayName: null, personal: true },
			{ slug: 'admin-0', displayName: 'ADMIN-0', personal: false },
			{ slug: 'builder-0', displayName: 'BUILDER-0', personal: false },
			{ slug: 'granted-0', displayName: 'GRANTED-0', personal: false },
			{ slug: 'team-0', displayName: 'TEAM-0', personal: false },
		],
	})
})

test('owner options prepare a fixed set of D1 statements however many orgs a person has', async () => {
	async function countStatements(copies: number) {
		const seed = await seedOrgs(copies)
		seed.queries.length = 0
		const options = await inRequest(() =>
			loadRepositoryCreateOptions(caller(seed.db)),
		)
		expect(options.ok && options.owners).toHaveLength(1 + copies * 4)
		// Bound lists grow with the orgs; the statements themselves must not.
		return seed.queries.map((sql) =>
			sql.replace(/\?(?:, \?)*/g, '?').replace(/\(\?\)(?:, \(\?\))+/g, '(?)'),
		)
	}
	const few = await countStatements(1)
	const many = await countStatements(3)
	expect(many).toEqual(few)
	expect(few).toHaveLength(8)
})
