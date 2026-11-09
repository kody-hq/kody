import { DatabaseSync } from 'node:sqlite'
import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { rolePresets } from '#worker/authorization/access-compile.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { inviteCreateCapability } from './invites.ts'
import {
	orgMemberRemoveCapability,
	orgMemberUpdateCapability,
} from './org-members.ts'
import { requireOrgPermission } from './shared.ts'

const ts = '2026-01-01T00:00:00.000Z'
const people = {
	owner: testStableUserIdFromEmail('admin-role-owner@example.com'),
	owner2: testStableUserIdFromEmail('admin-role-owner2@example.com'),
	admin: testStableUserIdFromEmail('admin-role-admin@example.com'),
	admin2: testStableUserIdFromEmail('admin-role-admin2@example.com'),
	member: testStableUserIdFromEmail('admin-role-member@example.com'),
	manager: testStableUserIdFromEmail('admin-role-manager@example.com'),
}
type Person = keyof typeof people
const roles: Record<Person, OrgRole> = {
	owner: 'owner',
	owner2: 'owner',
	admin: 'admin',
	admin2: 'admin',
	member: 'member',
	manager: 'member',
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const orgId = ownerIdFromStored('org-admin-role')
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, 'admin-role', 'Admin Role', 'free', 'public', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	for (const person of Object.keys(people) as Array<Person>) {
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(orgId, people[person], roles[person], ts)
			.run()
	}
	// The manager is a Member granted member:write and member:delete.
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('grant-manager', ?, 'org', ?, 'user', ?, ?, ?, ?)`,
		)
		.bind(orgId, orgId, people.manager, people.owner, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-manager', 'member:write'), ('grant-manager', 'member:delete')`,
		)
		.run()
	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env
	function as(person: Person) {
		return {
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(people[person]),
					email: `admin-role-${person}@example.com`,
					displayName: person,
				},
				orgBinding: {
					org: { id: orgId, slug: 'admin-role' },
					role: roles[person],
				},
			}),
		}
	}
	async function roleOf(person: Person) {
		const row = await db
			.prepare(
				`SELECT role, deleted_at FROM org_memberships
				 WHERE org_id = ? AND user_id = ?`,
			)
			.bind(orgId, people[person])
			.first<{ role: string; deleted_at: string | null }>()
		return row?.deleted_at ? 'removed' : row?.role
	}
	return { as, roleOf }
}

test('the Admin preset is every org permission except org:delete', () => {
	expect(rolePresets.admin.has('org:delete')).toBe(false)
	expect([...rolePresets.admin].sort()).toEqual(
		orgPermissions.filter((p) => p !== 'org:delete').sort(),
	)
})

test('an Admin cannot delete the org', async () => {
	const { as } = await setup()
	const ctx = as('admin')
	const request = ctx.callerContext.request!
	const access = await computeEffectivePermissions({ env: ctx.env, request })
	expect(access.isOwner).toBe(false)
	expect(access.isAdmin).toBe(true)
	expect(access.permissions.has('org:delete')).toBe(false)
	await expect(requireOrgPermission(ctx, 'org:delete')).rejects.toThrow(
		/org:delete/,
	)
	await expect(requireOrgPermission(ctx, 'member:delete')).resolves.toBeTruthy()
	await expect(
		requireOrgPermission(as('owner'), 'org:delete'),
	).resolves.toBeTruthy()
})

test('an Admin cannot demote or change an Owner', async () => {
	const { as, roleOf } = await setup()
	for (const role of ['admin', 'member', 'billing'] as const) {
		await expect(
			orgMemberUpdateCapability.handler(
				{ user_id: people.owner, role },
				as('admin'),
			),
		).rejects.toThrow(/Only an Owner can change the Owner role/)
	}
	expect(await roleOf('owner')).toBe('owner')
})

test('an Admin cannot promote anyone, including themselves, to Owner', async () => {
	const { as, roleOf } = await setup()
	for (const target of ['admin', 'admin2', 'member'] as const) {
		await expect(
			orgMemberUpdateCapability.handler(
				{ user_id: people[target], role: 'owner' },
				as('admin'),
			),
		).rejects.toThrow(/Only an Owner can change the Owner role/)
	}
	await expect(
		inviteCreateCapability.handler(
			{ kind: 'membership', email: 'new-owner@example.com', role: 'owner' },
			as('admin'),
		),
	).rejects.toThrow(/Only an Owner can invite another Owner/)
	expect(await roleOf('admin')).toBe('admin')
	expect(await roleOf('member')).toBe('member')
})

test('an Admin cannot remove an Owner', async () => {
	const { as, roleOf } = await setup()
	await expect(
		orgMemberRemoveCapability.handler({ user_id: people.owner2 }, as('admin')),
	).rejects.toThrow(/Only an Owner can remove an Owner/)
	expect(await roleOf('owner2')).toBe('owner')
})

test('an Admin manages Admins, Members, and Billing', async () => {
	const { as, roleOf } = await setup()
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.member, role: 'admin' },
			as('admin'),
		),
	).resolves.toMatchObject({ role: 'admin' })
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.admin2, role: 'billing' },
			as('admin'),
		),
	).resolves.toMatchObject({ role: 'billing' })
	await expect(
		orgMemberRemoveCapability.handler({ user_id: people.admin2 }, as('admin')),
	).resolves.toMatchObject({ removed: true })
	expect(await roleOf('member')).toBe('admin')
	expect(await roleOf('admin2')).toBe('removed')
})

test('a Member granted member:write cannot reach the Admin or Owner role', async () => {
	const { as, roleOf } = await setup()
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.member, role: 'admin' },
			as('manager'),
		),
	).rejects.toThrow(/Only an Owner or Admin can change the Admin role/)
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.manager, role: 'admin' },
			as('manager'),
		),
	).rejects.toThrow(/Only an Owner or Admin can change the Admin role/)
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.admin, role: 'member' },
			as('manager'),
		),
	).rejects.toThrow(/Only an Owner or Admin can change the Admin role/)
	await expect(
		orgMemberRemoveCapability.handler({ user_id: people.admin }, as('manager')),
	).rejects.toThrow(/Only an Owner or Admin can remove an Admin/)
	await expect(
		inviteCreateCapability.handler(
			{ kind: 'membership', email: 'new-admin@example.com', role: 'admin' },
			as('manager'),
		),
	).rejects.toThrow(/Only an Owner or Admin can invite an Admin/)
	expect(await roleOf('member')).toBe('member')
	expect(await roleOf('admin')).toBe('admin')
})

test('an Owner can make and unmake Admins', async () => {
	const { as, roleOf } = await setup()
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.admin, role: 'owner' },
			as('owner'),
		),
	).resolves.toMatchObject({ role: 'owner' })
	await expect(
		orgMemberUpdateCapability.handler(
			{ user_id: people.admin2, role: 'member' },
			as('owner'),
		),
	).resolves.toMatchObject({ role: 'member' })
	expect(await roleOf('admin')).toBe('owner')
	expect(await roleOf('admin2')).toBe('member')
})
