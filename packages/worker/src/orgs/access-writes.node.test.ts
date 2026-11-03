import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { compileAccessForRequest } from '#worker/authorization/access-compile.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { withAccessEpochWriteGuard } from '#worker/test-support/access-epoch-write-guard.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { FreeOrgLimitError } from './billing.ts'
import { offboardOrgMember } from './offboarding.ts'
import {
	addOrgMember,
	createOrg,
	OrgSlugValidationError,
	updateOrgMemberRole,
	upsertGrant,
} from './access-writes.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	cancelActiveWorkflowRunsForUser: vi.fn(async () => 0),
}))

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return withAccessEpochWriteGuard(createD1FromSqlite(sqlite))
}

test('createOrg and upsertGrant are visible when access is compiled', async () => {
	const db = await createDb()
	const creatorId = testStableUserIdFromEmail('creator@example.com')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'Rocket-Co',
		displayName: 'Rocket Co',
		createdByUserId: creatorId,
		audit: createTestOrgAuditWriter(),
	})
	expect(org.slug).toBe('rocket-co')
	expect(org.id).toMatch(/^[a-f0-9]{64}$/)
	expect(org.id).not.toBe(creatorId)

	const memberId = testStableUserIdFromEmail('member@example.com')
	const packageId = crypto.randomUUID()
	const grant = await upsertGrant({
		db,
		orgId: org.id,
		resourceType: 'package',
		resourceId: packageId,
		family: 'package',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: creatorId,
		audit: createTestOrgAuditWriter(),
	})
	expect(grant.permissions).toEqual(['package:read', 'package:execute'])

	const orgId: string = org.id
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'member',
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(orgId), slug: org.slug },
			role: 'member',
		},
	})
	const compiled = await compileAccessForRequest({ db, request })
	const packagePermissions = compiled.resourcePermissions.get(
		`package:${packageId}`,
	)
	expect(packagePermissions?.has('package:read')).toBe(true)
	expect(packagePermissions?.has('package:execute')).toBe(true)
	expect(compiled.orgPermissions.has('package:write')).toBe(false)
	expect(compiled.orgPermissions.has('org:execute')).toBe(true)
})

test('protectLastOwner blocks demotion and removal when only one owner remains', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('solo-owner@example.com')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'solo',
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	await expect(
		updateOrgMemberRole({
			db,
			orgId: org.id,
			userId: ownerId,
			role: 'member',
			protectLastOwner: true,
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toThrow(/last Owner cannot be demoted/)
	await expect(
		offboardOrgMember({
			appDb: db,
			env: { APP_DB: db } as Env,
			orgId: personalOrgId(org.id),
			memberUserId: ownerId,
			memberLeftVoluntarily: true,
		}),
	).rejects.toThrow('cannot_remove_last_owner')
	const stillOwner = await db
		.prepare(
			`SELECT role, deleted_at FROM org_memberships
			 WHERE org_id = ? AND user_id = ?`,
		)
		.bind(org.id, ownerId)
		.first<{ role: string; deleted_at: string | null }>()
	expect(stillOwner).toEqual({ role: 'owner', deleted_at: null })
})

test('removing a member soft-deletes their direct user grants', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('grant-owner@example.com')
	const memberId = testStableUserIdFromEmail('grant-member@example.com')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'grants',
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	await addOrgMember({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'member',
		invitedByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	const packageId = crypto.randomUUID()
	const grant = await upsertGrant({
		db,
		orgId: org.id,
		resourceType: 'package',
		resourceId: packageId,
		family: 'package',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	await offboardOrgMember({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: personalOrgId(org.id),
		memberUserId: memberId,
		memberLeftVoluntarily: true,
	})
	const membership = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships
			 WHERE org_id = ? AND user_id = ?`,
		)
		.bind(org.id, memberId)
		.first<{ deleted_at: string | null }>()
	expect(membership?.deleted_at).toBeTruthy()
	const storedGrant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = ? AND org_id = ?`)
		.bind(grant.id, org.id)
		.first<{ deleted_at: string | null }>()
	expect(storedGrant?.deleted_at).toBeTruthy()
})

test('write helpers record org audit events for the acting person', async () => {
	const db = await createDb()
	const auditDb = createAuditTestDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const audit = createTestOrgAuditWriter({
		db: auditDb,
		appDb: db,
		actorUserId: ownerId,
	})
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'auditco',
		createdByUserId: ownerId,
		audit,
	})
	await addOrgMember({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'member',
		invitedByUserId: ownerId,
		audit,
	})
	await updateOrgMemberRole({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'billing',
		audit,
	})
	// Re-adding a live member and re-applying the same role are no-ops.
	await addOrgMember({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'owner',
		invitedByUserId: ownerId,
		audit,
	})
	await updateOrgMemberRole({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'billing',
		audit,
	})
	const grant = await upsertGrant({
		db,
		orgId: org.id,
		resourceType: 'package',
		resourceId: 'pkg-1',
		family: 'package',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit,
	})

	const rows = await auditDb
		.prepare(
			`SELECT action, actor_user_id, target_user_id, resource_type, resource_id
			 FROM org_audit_events WHERE org_id = ? ORDER BY rowid ASC`,
		)
		.bind(org.id)
		.all<{
			action: string
			actor_user_id: string | null
			target_user_id: string | null
			resource_type: string | null
			resource_id: string | null
		}>()
	expect(rows.results).toEqual([
		{
			action: 'org.created',
			actor_user_id: ownerId,
			target_user_id: null,
			resource_type: null,
			resource_id: null,
		},
		{
			action: 'member.added',
			actor_user_id: ownerId,
			target_user_id: memberId,
			resource_type: null,
			resource_id: null,
		},
		{
			action: 'member.role_changed',
			actor_user_id: ownerId,
			target_user_id: memberId,
			resource_type: null,
			resource_id: null,
		},
		{
			action: 'grant.created',
			actor_user_id: ownerId,
			target_user_id: memberId,
			resource_type: 'package',
			resource_id: 'pkg-1',
		},
	])
	expect(grant.permissions).toEqual(['package:read', 'package:execute'])
})

test('an audit write failure is reported without undoing the access change', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'auditco',
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	const failingAuditDb = {
		prepare() {
			throw new Error('AUDIT_DB is unavailable')
		},
	} as unknown as D1Database
	await addOrgMember({
		db,
		orgId: org.id,
		userId: memberId,
		role: 'member',
		invitedByUserId: ownerId,
		audit: createTestOrgAuditWriter({
			db: failingAuditDb,
			appDb: db,
			actorUserId: ownerId,
		}),
	})
	const outbox = await db
		.prepare(`SELECT id, org_id, payload_json FROM org_audit_outbox`)
		.all<{ id: string; org_id: string; payload_json: string }>()
	expect(outbox.results).toHaveLength(1)
	expect(outbox.results[0]?.org_id).toBe(org.id)
	expect(JSON.parse(outbox.results[0]?.payload_json ?? '{}')).toMatchObject({
		action: 'member.added',
		orgId: org.id,
	})
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(org.id, memberId)
		.first<{ role: string }>()
	expect(membership?.role).toBe('member')
})

test('createOrg rejects reserved and claimed handles via the shared claim helper', async () => {
	const db = await createDb()
	const creatorId = testStableUserIdFromEmail('claimer@example.com')
	await expect(
		createOrg({
			db,
			env: {} as Env,
			slug: 'admin',
			createdByUserId: creatorId,
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toBeInstanceOf(OrgSlugValidationError)
	await expect(
		createOrg({
			db,
			env: {} as Env,
			slug: 'admin',
			createdByUserId: creatorId,
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toThrow('This username is reserved.')
	for (const slug of ['me', 'ME']) {
		await expect(
			createOrg({
				db,
				env: {} as Env,
				slug,
				createdByUserId: creatorId,
				audit: createTestOrgAuditWriter(),
			}),
		).rejects.toThrow('This username is reserved.')
	}

	const taken = await createOrg({
		db,
		env: {} as Env,
		slug: 'already-taken',
		createdByUserId: creatorId,
		audit: createTestOrgAuditWriter(),
	})
	await expect(
		createOrg({
			db,
			env: {} as Env,
			slug: taken.slug,
			createdByUserId: testStableUserIdFromEmail('other@example.com'),
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toThrow('That name is taken.')
})

test('createOrg refuses a third free org inside the insert and leaves no partial rows', async () => {
	const db = await createDb()
	const creatorId = testStableUserIdFromEmail('capped@example.com')
	for (const slug of ['capped-one', 'capped-two']) {
		await createOrg({
			db,
			env: {} as Env,
			slug,
			createdByUserId: creatorId,
			audit: createTestOrgAuditWriter(),
		})
	}

	await expect(
		createOrg({
			db,
			env: {} as Env,
			slug: 'capped-three',
			createdByUserId: creatorId,
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toBeInstanceOf(FreeOrgLimitError)

	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'capped-three'`)
		.first<{ id: string }>()
	expect(org).toBeNull()
	const handle = await db
		.prepare(`SELECT handle FROM handles WHERE handle = 'capped-three'`)
		.first<{ handle: string }>()
	expect(handle).toBeNull()
	const owned = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM org_memberships WHERE user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(creatorId)
		.first<{ count: number }>()
	expect(owned?.count).toBe(2)
})
