import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { orgCreateCapability } from '#mcp/capabilities/access/org-members.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { orgUpdateCapability } from './org-update.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db })
	return db
}

function context(input: {
	db: D1Database
	userId: string
	org: { id: string; slug: string; role: 'owner' | 'member' | 'billing' }
}) {
	return {
		env: { APP_DB: input.db, AUDIT_DB: createAuditTestDb() } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(input.userId),
				email: 'ada@example.com',
				displayName: 'Ada',
				username: 'ada',
			},
			orgBinding: {
				org: {
					id: ownerIdFromStored(input.org.id),
					slug: input.org.slug,
				},
				role: input.org.role,
			},
		}),
	}
}

test('orgUpdate changes a team org display name, keeps the handle permanent, and refuses a personal org', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'ada', 'ada@example.com', 'x', ?)`,
		)
		.bind(ada)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'zeta-co', display_name: 'Zeta Co' },
		{
			env: { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(ada),
					email: 'ada@example.com',
					displayName: 'Ada',
					username: 'ada',
				},
			}),
		},
	)
	const updated = await orgUpdateCapability.handler(
		{ display_name: 'Zeta Company' },
		context({
			db,
			userId: ada,
			org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
		}),
	)
	expect(updated.org).toEqual({
		id: created.org.id,
		slug: 'zeta-co',
		display_name: 'Zeta Company',
		profile_visibility: 'public',
		members_can_create_packages: false,
		members_can_create_credentials: true,
	})

	await expect(
		orgUpdateCapability.handler(
			{ slug: 'zeta-company' },
			context({
				db,
				userId: ada,
				org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
			}),
		),
	).rejects.toThrow(/permanent/)
	expect(
		await db
			.prepare(`SELECT slug FROM orgs WHERE id = ?`)
			.bind(created.org.id)
			.first(),
	).toEqual({ slug: 'zeta-co' })

	await expect(
		orgUpdateCapability.handler(
			{ display_name: 'Ada Org' },
			context({
				db,
				userId: ada,
				org: { id: ada, slug: 'ada', role: 'owner' },
			}),
		),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('orgUpdate requires an input field', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada2@example.com')
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: ada,
			slug: 'zeta',
			displayName: 'Zeta',
			audit: createTestOrgAuditWriter(),
		},
	)
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta'`)
		.first<{ id: string }>()
	await expect(
		orgUpdateCapability.handler(
			{},
			context({
				db,
				userId: ada,
				org: { id: org!.id, slug: 'zeta', role: 'owner' },
			}),
		),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('orgCreate defaults to a public page and accepts private; orgUpdate toggles it for owners only, with an audit event', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada3@example.com')
	const bea = testStableUserIdFromEmail('bea3@example.com')
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'ada', 'ada3@example.com', 'x', ?), (2, 'bea', 'bea3@example.com', 'x', ?)`,
		)
		.bind(ada, bea)
		.run()
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada' })
	await provisionPersonalOrg(db, { stableUserId: bea, username: 'bea' })
	const auditDb = createAuditTestDb()
	const env = { APP_DB: db, AUDIT_DB: auditDb } as Env
	const signedInAda = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored(ada),
			email: 'ada3@example.com',
			displayName: 'Ada',
			username: 'ada',
		},
	})
	const open = await orgCreateCapability.handler(
		{ slug: 'acme-team' },
		{ env, callerContext: signedInAda },
	)
	expect(open.org.profile_visibility).toBe('public')
	// The free plan allows one team org next to the personal one, so the
	// private create runs as the second person.
	const closed = await orgCreateCapability.handler(
		{ slug: 'acme-private', profile_visibility: 'private' },
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(bea),
					email: 'bea3@example.com',
					displayName: 'Bea',
					username: 'bea',
				},
			}),
		},
	)
	expect(closed.org.profile_visibility).toBe('private')

	const ownerContext = {
		env,
		callerContext: context({
			db,
			userId: ada,
			org: { id: open.org.id, slug: 'acme-team', role: 'owner' },
		}).callerContext,
	}
	const updated = await orgUpdateCapability.handler(
		{ profile_visibility: 'private' },
		ownerContext,
	)
	expect(updated.org).toMatchObject({
		slug: 'acme-team',
		profile_visibility: 'private',
	})
	const { results } = await auditDb
		.prepare(
			`SELECT action, details_json, actor_user_id FROM org_audit_events
			 WHERE action = 'org.profile_visibility_changed'`,
		)
		.all<{ action: string; details_json: string; actor_user_id: string }>()
	expect(results).toHaveLength(1)
	expect(JSON.parse(results[0]!.details_json)).toEqual({
		profile_visibility: 'private',
		previous_profile_visibility: 'public',
	})

	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(open.org.id, bea, new Date().toISOString())
		.run()
	await db
		.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`)
		.bind(open.org.id)
		.run()
	await expect(
		orgUpdateCapability.handler(
			{ profile_visibility: 'public' },
			{
				env,
				callerContext: context({
					db,
					userId: bea,
					org: { id: open.org.id, slug: 'acme-team', role: 'member' },
				}).callerContext,
			},
		),
	).rejects.toThrow(/org:write/)
	expect(
		await db
			.prepare(`SELECT profile_visibility FROM orgs WHERE id = ?`)
			.bind(open.org.id)
			.first(),
	).toEqual({ profile_visibility: 'private' })
})

test('orgUpdate lets an Owner set member permissions on a team org and audits it', async () => {
	const db = await createDb()
	const auditDb = createAuditTestDb()
	const env = { APP_DB: db, AUDIT_DB: auditDb } as Env
	const ada = testStableUserIdFromEmail('ada-member-perms@example.com')
	const bea = testStableUserIdFromEmail('bea-member-perms@example.com')
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'ada', 'ada-member-perms@example.com', 'x', ?)`,
		)
		.bind(ada)
		.run()
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada' })
	const created = await orgCreateCapability.handler(
		{ slug: 'member-perms' },
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(ada),
					email: 'ada-member-perms@example.com',
					displayName: 'Ada',
					username: 'ada',
				},
			}),
		},
	)
	const org = { id: created.org.id, slug: 'member-perms' }
	const updated = await orgUpdateCapability.handler(
		{
			members_can_create_packages: true,
			members_can_create_credentials: false,
		},
		{
			env,
			callerContext: context({
				db,
				userId: ada,
				org: { ...org, role: 'owner' },
			}).callerContext,
		},
	)
	expect(updated.org).toMatchObject({
		members_can_create_packages: true,
		members_can_create_credentials: false,
	})
	const { results } = await auditDb
		.prepare(
			`SELECT details_json FROM org_audit_events
			 WHERE action = 'org.member_creation_changed'`,
		)
		.all<{ details_json: string }>()
	expect(results).toHaveLength(1)
	expect(JSON.parse(results[0]!.details_json)).toEqual({
		members_can_create_packages: true,
		members_can_create_credentials: false,
		previous_members_can_create_packages: false,
		previous_members_can_create_credentials: true,
	})

	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(org.id, bea, new Date().toISOString())
		.run()
	await expect(
		orgUpdateCapability.handler(
			{ members_can_create_credentials: true },
			{
				env,
				callerContext: context({
					db,
					userId: bea,
					org: { ...org, role: 'member' },
				}).callerContext,
			},
		),
	).rejects.toThrow(/org:write/)

	await expect(
		orgUpdateCapability.handler(
			{ members_can_create_packages: true },
			context({
				db,
				userId: ada,
				org: { id: ada, slug: 'ada', role: 'owner' },
			}),
		),
	).rejects.toBeInstanceOf(McpCallerError)
})
