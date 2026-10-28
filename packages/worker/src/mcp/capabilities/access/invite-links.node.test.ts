import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { LivePersonRequiredError } from '#worker/authorization/authorize.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { type RequestSource } from '#worker/request-context/request-context.ts'
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
	inviteLinkAcceptCapability,
	inviteLinkCreateCapability,
	inviteLinkListCapability,
	inviteLinkRevokeCapability,
} from './invite-links.ts'
import { orgCreateCapability } from './org-members.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at'],
	})
	return { db, sqlite }
}

async function insertPerson(
	db: D1Database,
	input: {
		personId: string
		username: string
		email: string
		emailVerifiedAt?: string | null
	},
) {
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, email_verified_at
			 ) VALUES (?, ?, 'x', ?, ?)`,
		)
		.bind(
			input.username,
			input.email,
			input.personId,
			input.emailVerifiedAt === undefined
				? '2026-01-01T00:00:00.000Z'
				: input.emailVerifiedAt,
		)
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

async function createTeamOrg(db: D1Database, email: string, username: string) {
	const ownerId = testStableUserIdFromEmail(email)
	await insertPerson(db, {
		personId: ownerId,
		username,
		email,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username,
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email,
		username,
	})
	const created = await orgCreateCapability.handler(
		{ slug: `${username}-co` },
		ownerOnPersonal,
	)
	const ownerOnOrg = capabilityContext({
		db,
		userId: ownerId,
		email,
		username,
		org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
	})
	return { ownerId, created, ownerOnOrg }
}

test('inviteLinkCreate returns token once, list omits it, accept joins, revoke blocks', async () => {
	const { db } = await createDb()
	const { created, ownerOnOrg } = await createTeamOrg(
		db,
		'link-owner@example.com',
		'linkowner',
	)
	const guestId = testStableUserIdFromEmail('link-guest@example.com')
	await insertPerson(db, {
		personId: guestId,
		username: 'linkguest',
		email: 'link-guest@example.com',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guestId,
		username: 'linkguest',
	})

	const createdLink = await inviteLinkCreateCapability.handler(
		{
			kind: 'membership',
			role: 'member',
			label: 'Launch week',
			expires_in_days: 14,
		},
		ownerOnOrg,
	)
	expect(createdLink.token).toMatch(/^[a-f0-9]{64}$/)
	expect(createdLink.url).toBe(`https://heykody.dev/join/${createdLink.token}`)
	expect(createdLink.prompt).toContain('inviteLinkAccept')
	expect(createdLink.prompt).toContain(createdLink.token)
	expect(createdLink.invite_link).toMatchObject({
		kind: 'membership',
		role: 'member',
		label: 'Launch week',
		use_count: 0,
		last_used_at: null,
		team_ids: [],
	})

	const listed = await inviteLinkListCapability.handler({}, ownerOnOrg)
	expect(listed.invite_links).toHaveLength(1)
	expect(listed.invite_links[0]).toMatchObject({
		id: createdLink.invite_link.id,
		role: 'member',
		label: 'Launch week',
		created_by_username: 'linkowner',
	})
	expect(listed.invite_links[0]).not.toHaveProperty('token')

	const guest = capabilityContext({
		db,
		userId: guestId,
		email: 'link-guest@example.com',
		username: 'linkguest',
	})
	const accepted = await inviteLinkAcceptCapability.handler(
		{ token: createdLink.token },
		guest,
	)
	expect(accepted).toEqual({
		org_slug: created.org.slug,
		already_member: false,
		role: 'member',
		kind: 'membership',
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
		.prepare(`SELECT token_hash, use_count FROM org_invite_links WHERE id = ?`)
		.bind(createdLink.invite_link.id)
		.first<{ token_hash: string; use_count: number }>()
	expect(stored?.token_hash).not.toBe(createdLink.token)
	expect(stored?.use_count).toBe(1)

	const second = await inviteLinkCreateCapability.handler(
		{ role: 'billing' },
		ownerOnOrg,
	)
	await inviteLinkRevokeCapability.handler(
		{ invite_link_id: second.invite_link.id },
		ownerOnOrg,
	)
	await expect(
		inviteLinkAcceptCapability.handler({ token: second.token }, guest),
	).rejects.toBeInstanceOf(McpCallerError)
	await expect(
		inviteLinkAcceptCapability.handler({ token: second.token }, guest),
	).rejects.toThrow(/revoked/i)
})

test('inviteLinkCreate refuses Owner and personal orgs; needs a live person', async () => {
	const { db } = await createDb()
	const ownerId = testStableUserIdFromEmail('personal-link@example.com')
	await insertPerson(db, {
		personId: ownerId,
		username: 'personallink',
		email: 'personal-link@example.com',
	})
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'personallink',
	})
	const ownerOnPersonal = capabilityContext({
		db,
		userId: ownerId,
		email: 'personal-link@example.com',
		username: 'personallink',
	})
	await expect(
		inviteLinkCreateCapability.handler({ kind: 'membership' }, ownerOnPersonal),
	).rejects.toThrow(/personal organization/i)

	const { ownerOnOrg } = await createTeamOrg(
		db,
		'live-link@example.com',
		'livelink',
	)
	await expect(
		inviteLinkCreateCapability.handler(
			{ kind: 'membership' },
			{
				...ownerOnOrg,
				callerContext: createMcpCallerContext({
					source: { kind: 'schedule', jobId: 'job-1' },
					baseUrl: 'https://heykody.dev',
					user: ownerOnOrg.callerContext.user,
					orgBinding: {
						org: {
							id: ownerOnOrg.callerContext.request!.org.id,
							slug: ownerOnOrg.callerContext.request!.org.slug,
						},
						role: 'owner',
					},
				}),
			},
		),
	).rejects.toBeInstanceOf(LivePersonRequiredError)
})
