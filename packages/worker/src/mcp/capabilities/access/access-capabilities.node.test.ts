import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { compileAccessForRequest } from '#worker/authorization/access-compile.ts'
import { LivePersonRequiredError } from '#worker/authorization/authorize.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	deriveRequestContext,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	accessGrantCapability,
	accessRevokeCapability,
} from './access-grants.ts'
import { inviteAcceptCapability, inviteCreateCapability } from './invites.ts'
import { orgCreateCapability, orgMemberListCapability } from './org-members.ts'
import { teamCreateCapability } from './teams.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db })
	return db
}

async function insertPerson(
	db: D1Database,
	input: { personId: string; username: string; email: string },
) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES (?, ?, 'x', ?)`,
		)
		.bind(input.username, input.email, input.personId)
		.run()
}

function capabilityContext(input: {
	db: D1Database
	userId: string
	email: string
	username: string
	org?: { id: string; slug: string; role: OrgRole | null }
	auditDb?: D1Database
	source?: RequestSource
}) {
	return {
		env: {
			APP_DB: input.db,
			AUDIT_DB: input.auditDb ?? createAuditTestDb(),
		} as Env,
		callerContext: createMcpCallerContext({
			source: input.source ?? { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(input.userId),
				email: input.email,
				displayName: input.username,
				username: input.username,
			},
			orgBinding: input.org
				? {
						org: {
							id: ownerIdFromStored(input.org.id),
							slug: input.org.slug,
						},
						role: input.org.role,
					}
				: undefined,
		}),
	}
}

test('orgCreate and accessGrant show up in access compile', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneruser',
	})
	const owner = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner@example.com',
		username: 'owneruser',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'Rocket-Co', display_name: 'Rocket Co' },
		owner,
	)
	expect(created.org.slug).toBe('rocket-co')
	expect(created.org.display_name).toBe('Rocket Co')
	expect(created.org.id).toMatch(/^[a-f0-9]{64}$/)
	expect(created.org.id).not.toBe(ownerId)

	const guestId = testStableUserIdFromEmail('guest@example.com')
	const packageId = crypto.randomUUID()
	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: packageId,
			subject_type: 'user',
			subject_id: guestId,
			preset: 'use',
		},
		capabilityContext({
			db,
			userId: ownerId,
			email: 'owner@example.com',
			username: 'owneruser',
			org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
		}),
	)
	expect(granted.grant.permissions).toEqual(['package:execute', 'package:read'])

	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(guestId),
			username: 'guestuser',
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(created.org.id), slug: 'rocket-co' },
			role: 'member',
		},
	})
	const compiled = await compileAccessForRequest({ db, request })
	expect(
		compiled.resourcePermissions
			.get(`package:${packageId}`)
			?.has('package:execute'),
	).toBe(true)
	expect(compiled.orgPermissions.has('package:write')).toBe(false)
})

test('teamCreate refuses the personal organization', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner-personal-team@example.com')
	await insertPerson(db, {
		personId: ownerId,
		username: 'personalteamowner',
		email: 'owner-personal-team@example.com',
	})
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'personalteamowner',
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner-personal-team@example.com',
		username: 'personalteamowner',
	})
	await expect(
		teamCreateCapability.handler(
			{ slug: 'core', name: 'Core' },
			ownerOnPersonal,
		),
	).rejects.toThrow(/team organizations/i)
})

test('inviteCreate membership refuses the personal organization', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner-personal-invite@example.com')
	await insertPerson(db, {
		personId: ownerId,
		username: 'personalowner',
		email: 'owner-personal-invite@example.com',
	})
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'personalowner',
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner-personal-invite@example.com',
		username: 'personalowner',
	})
	await expect(
		inviteCreateCapability.handler(
			{ kind: 'membership', email: 'guest@example.com', role: 'member' },
			ownerOnPersonal,
		),
	).rejects.toBeInstanceOf(McpCallerError)
	await expect(
		inviteCreateCapability.handler(
			{ kind: 'membership', email: 'guest@example.com', role: 'member' },
			ownerOnPersonal,
		),
	).rejects.toThrow(/personal organization/i)
})

test('inviteCreate prompt names the org and inviteAccept writes membership', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner2@example.com')
	const guestId = testStableUserIdFromEmail('guest2@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneracct',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guestId,
		username: 'guestacct',
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner2@example.com',
		username: 'owneracct',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'northwind' },
		ownerOnPersonal,
	)
	const ownerOnOrg = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner2@example.com',
		username: 'owneracct',
		org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
	})
	const invited = await inviteCreateCapability.handler(
		{ kind: 'membership', email: 'Guest2@Example.com', role: 'member' },
		ownerOnOrg,
	)
	expect(invited.invite.org_slug).toBe('northwind')
	expect(invited.invite.status).toBe('pending')
	expect(invited.prompt).toContain('northwind')
	expect(invited.prompt).toContain('inviteAccept')
	expect(invited.prompt).toContain(invited.token)
	expect(invited.prompt).not.toMatch(/[—–]/)
	expect(invited.token).toMatch(/^[a-f0-9]{64}$/)

	const wrongAccount = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner2@example.com',
		username: 'owneracct',
	})
	await expect(
		inviteAcceptCapability.handler({ token: invited.token }, wrongAccount),
	).rejects.toBeInstanceOf(McpCallerError)

	const guestAuditDb = createAuditTestDb()
	const guest = capabilityContext({
		db,
		userId: guestId,
		email: 'guest2@example.com',
		username: 'guestacct',
		auditDb: guestAuditDb,
	})
	const accepted = await inviteAcceptCapability.handler(
		{ token: invited.token },
		guest,
	)
	expect(accepted).toEqual({
		invite_id: invited.invite.id,
		org_id: created.org.id,
		org_slug: 'northwind',
		kind: 'membership',
		status: 'accepted',
	})
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(created.org.id, guestId)
		.first<{ role: string }>()
	expect(membership?.role).toBe('member')

	const stored = await db
		.prepare(`SELECT token_hash, status FROM invites WHERE id = ?`)
		.bind(invited.invite.id)
		.first<{ token_hash: string; status: string }>()
	expect(stored?.status).toBe('accepted')
	expect(stored?.token_hash).not.toBe(invited.token)

	// Acceptance is recorded only after the membership write landed.
	const auditRows = await guestAuditDb
		.prepare(
			`SELECT action FROM org_audit_events
			 WHERE org_id = ? ORDER BY rowid ASC`,
		)
		.bind(created.org.id)
		.all<{ action: string }>()
	expect(auditRows.results.map((row) => row.action)).toEqual([
		'member.added',
		'invite.accepted',
	])
})

test('orgMemberList returns live members and requires member:read', async () => {
	const db = await createDb()
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	const ownerId = testStableUserIdFromEmail('lister@example.com')
	const guestId = testStableUserIdFromEmail('listed@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'lister',
	})
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, display_name)
			 VALUES ('lister', 'lister@example.com', 'x', ?, 'Lister')`,
		)
		.bind(ownerId)
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, display_name)
			 VALUES ('listed', 'listed@example.com', 'x', ?, 'Listed')`,
		)
		.bind(guestId)
		.run()
	const created = await orgCreateCapability.handler(
		{ slug: 'listed-co' },
		capabilityContext({
			db,
			userId: ownerId,
			email: 'lister@example.com',
			username: 'lister',
		}),
	)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(created.org.id, guestId)
		.run()
	const listed = await orgMemberListCapability.handler(
		{},
		capabilityContext({
			db,
			userId: ownerId,
			email: 'lister@example.com',
			username: 'lister',
			org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
		}),
	)
	expect(
		listed.members.map((member) => [member.username, member.role]),
	).toEqual([
		['lister', 'owner'],
		['listed', 'member'],
	])

	await expect(
		orgMemberListCapability.handler(
			{},
			capabilityContext({
				db,
				userId: guestId,
				email: 'listed@example.com',
				username: 'listed',
				org: { id: created.org.id, slug: created.org.slug, role: 'member' },
			}),
		),
	).resolves.toMatchObject({
		members: expect.arrayContaining([
			expect.objectContaining({ username: 'lister' }),
		]),
	})
})

test('inviteAccept rejects invites for suspended orgs', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner3@example.com')
	const guestId = testStableUserIdFromEmail('guest3@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneracct3',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guestId,
		username: 'guestacct3',
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner3@example.com',
		username: 'owneracct3',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'paused-co' },
		ownerOnPersonal,
	)
	const ownerOnOrg = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner3@example.com',
		username: 'owneracct3',
		org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
	})
	const invited = await inviteCreateCapability.handler(
		{ kind: 'membership', email: 'guest3@example.com', role: 'member' },
		ownerOnOrg,
	)
	await db
		.prepare(
			`UPDATE orgs SET suspended_at = '2026-01-05T00:00:00.000Z' WHERE id = ?`,
		)
		.bind(created.org.id)
		.run()

	const guest = capabilityContext({
		db,
		userId: guestId,
		email: 'guest3@example.com',
		username: 'guestacct3',
	})
	await expect(
		inviteAcceptCapability.handler({ token: invited.token }, guest),
	).rejects.toThrow('organization is not active')
	const stored = await db
		.prepare(`SELECT status FROM invites WHERE id = ?`)
		.bind(invited.invite.id)
		.first<{ status: string }>()
	expect(stored?.status).toBe('pending')
})

test('orgCreate rejects reserved and malformed slugs with the shared validation', async () => {
	const db = await createDb()
	const creatorId = testStableUserIdFromEmail('creator@example.com')
	const ctx = capabilityContext({
		db,
		userId: creatorId,
		email: 'creator@example.com',
		username: 'creator',
	})
	await expect(
		orgCreateCapability.handler({ slug: 'admin' }, ctx),
	).rejects.toThrow('This username is reserved.')
	for (const slug of ['me', 'ME']) {
		await expect(orgCreateCapability.handler({ slug }, ctx)).rejects.toThrow(
			'This username is reserved.',
		)
	}
	await expect(
		orgCreateCapability.handler({ slug: '-bad-' }, ctx),
	).rejects.toThrow(/3 to 32 characters/)
	const orgs = await db
		.prepare(`SELECT COUNT(*) AS n FROM orgs`)
		.first<{ n: number }>()
	expect(orgs?.n).toBe(0)
})

test('org grants that hand out Owner-held permissions require an Owner', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneruser',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'delegateco' },
		capabilityContext({
			db,
			userId: ownerId,
			email: 'owner@example.com',
			username: 'owneruser',
		}),
	)
	const org = { id: created.org.id, slug: created.org.slug }
	const delegateId = testStableUserIdFromEmail('delegate@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: delegateId,
		username: 'delegateuser',
	})
	const owner = capabilityContext({
		db,
		userId: ownerId,
		email: 'owner@example.com',
		username: 'owneruser',
		org: { ...org, role: 'owner' },
	})
	const delegated = await accessGrantCapability.handler(
		{
			resource_type: 'org',
			resource_id: org.id,
			subject_type: 'user',
			subject_id: delegateId,
			permissions: ['member:read', 'member:write'],
		},
		owner,
	)
	expect(delegated.grant.permissions).toEqual(['member:read', 'member:write'])

	const delegate = capabilityContext({
		db,
		userId: delegateId,
		email: 'delegate@example.com',
		username: 'delegateuser',
		org: { ...org, role: null },
	})
	const otherId = testStableUserIdFromEmail('other@example.com')
	for (const permission of ['member:write', 'member:delete'] as const) {
		for (const subjectId of [delegateId, otherId]) {
			await expect(
				accessGrantCapability.handler(
					{
						resource_type: 'org',
						resource_id: org.id,
						subject_type: 'user',
						subject_id: subjectId,
						permissions: [permission],
					},
					delegate,
				),
			).rejects.toThrow(
				new McpCallerError(
					`Only an Owner can grant ${permission} on an organization.`,
				),
			)
		}
	}

	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'org',
				resource_id: org.id,
				subject_type: 'user',
				subject_id: delegateId,
				permissions: ['billing:write'],
			},
			owner,
		),
	).rejects.toThrow(
		new McpCallerError('Permission billing:write cannot be granted on org.'),
	)

	const teamRead = await accessGrantCapability.handler(
		{
			resource_type: 'org',
			resource_id: org.id,
			subject_type: 'user',
			subject_id: otherId,
			permissions: ['team:read'],
		},
		delegate,
	)
	expect(teamRead.grant.permissions).toEqual(['team:read'])
})

test('member and billing grant changes need a live person; other grants do not', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('owner-live@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'liveowner',
	})
	const ownerIdentity = {
		db,
		userId: ownerId,
		email: 'owner-live@example.com',
		username: 'liveowner',
	}
	const created = await orgCreateCapability.handler(
		{ slug: 'liveco' },
		capabilityContext(ownerIdentity),
	)
	const org = {
		id: created.org.id,
		slug: created.org.slug,
		role: 'owner' as const,
	}
	const live = capabilityContext({ ...ownerIdentity, org })
	const scheduled = capabilityContext({
		...ownerIdentity,
		org,
		source: {
			kind: 'schedule',
			jobId: 'job-1',
			enablement: {
				id: 'enablement-1',
				enabler: {
					userId: personIdFromStored(ownerId),
					username: 'liveowner',
				},
				role: 'owner',
			},
		},
	})
	const subjectId = testStableUserIdFromEmail('subject-live@example.com')
	const otherSubjectId = testStableUserIdFromEmail('other-live@example.com')
	const memberGrant = {
		resource_type: 'org' as const,
		resource_id: org.id,
		subject_type: 'user' as const,
		subject_id: subjectId,
		permissions: ['member:read'],
	}

	await expect(
		accessGrantCapability.handler(memberGrant as never, scheduled),
	).rejects.toMatchObject({
		name: 'LivePersonRequiredError',
		capabilityName: 'accessGrant',
	})
	const granted = await accessGrantCapability.handler(
		memberGrant as never,
		live,
	)
	await expect(
		accessGrantCapability.handler(
			{ ...memberGrant, permissions: ['team:read'] } as never,
			scheduled,
		),
	).rejects.toMatchObject({
		name: 'LivePersonRequiredError',
		capabilityName: 'accessGrant',
	})

	const teamRead = await accessGrantCapability.handler(
		{
			...memberGrant,
			subject_id: otherSubjectId,
			permissions: ['team:read'],
		} as never,
		scheduled,
	)
	expect(teamRead.grant.permissions).toEqual(['team:read'])

	const orgPreset = accessGrantCapability.handler(
		{
			...memberGrant,
			subject_id: otherSubjectId,
			permissions: undefined,
			preset: 'manage',
		} as never,
		scheduled,
	)
	await expect(orgPreset).rejects.toThrow(
		'Grant presets do not apply to the org resource',
	)
	await expect(orgPreset).rejects.not.toBeInstanceOf(LivePersonRequiredError)

	const memberId = testStableUserIdFromEmail('member-live@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: memberId,
		username: 'livemember',
	})
	const scheduledMember = capabilityContext({
		db,
		userId: memberId,
		email: 'member-live@example.com',
		username: 'livemember',
		org: { ...org, role: 'member' },
		source: {
			kind: 'schedule',
			jobId: 'job-2',
			enablement: {
				id: 'enablement-2',
				enabler: {
					userId: personIdFromStored(memberId),
					username: 'livemember',
				},
				role: 'member',
			},
		},
	})
	await expect(
		accessGrantCapability.handler(
			{ ...memberGrant, permissions: ['team:read'] } as never,
			scheduledMember,
		),
	).rejects.toMatchObject({
		name: 'AuthorizationError',
		permission: 'member:write',
	})
	await expect(
		accessRevokeCapability.handler(
			{ grant_id: granted.grant.id },
			scheduledMember,
		),
	).rejects.toMatchObject({
		name: 'AuthorizationError',
		permission: 'member:write',
	})

	await expect(
		accessRevokeCapability.handler({ grant_id: granted.grant.id }, scheduled),
	).rejects.toMatchObject({
		name: 'LivePersonRequiredError',
		capabilityName: 'accessRevoke',
	})
	await expect(
		accessRevokeCapability.handler({ grant_id: teamRead.grant.id }, scheduled),
	).resolves.toMatchObject({ revoked: true })
	await expect(
		accessRevokeCapability.handler({ grant_id: granted.grant.id }, live),
	).resolves.toMatchObject({ revoked: true })
})
