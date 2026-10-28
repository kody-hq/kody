/**
 * accessGrant / accessRevoke / grant invites on credentials keyed by stable
 * credential id, against a fully migrated APP_DB.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { deleteSecret, saveSecret } from '#mcp/secrets/service.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { secretListCapability } from '../secrets/secret-list.ts'
import {
	accessGrantCapability,
	accessListCapability,
	accessRevokeCapability,
} from './access-grants.ts'
import { inviteAcceptCapability, inviteCreateCapability } from './invites.ts'

const now = '2026-10-10T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const guestId = testStableUserIdFromEmail('guest@example.com')
	for (const [index, [stableUserId, username]] of [
		[ownerId, 'owneruser'],
		[memberId, 'memberuser'],
		[guestId, 'guestuser'],
	].entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				stableUserId,
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: stableUserId!,
			username: username!,
			createdAt: now,
		})
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const orgId = ownerIdFromStored(ownerId)
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'apiKey',
		value: 'secret-value',
		audit: null,
	})
	const ctx = (
		userId: string,
		username: string,
		role: OrgRole | null,
		org = { id: ownerId, slug: 'owneruser' },
	) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(org.id), slug: org.slug },
				role,
			},
		}),
	})
	const owner = ctx(ownerId, 'owneruser', 'owner')
	const listed = await secretListCapability.handler({ scope: 'user' }, owner)
	const credentialId = listed.secrets.find(
		(secret) => secret.name === 'apiKey',
	)?.credential_id
	if (!credentialId) throw new Error('secretList returned no credential id.')
	return {
		env,
		db,
		orgId,
		ownerId,
		memberId,
		guestId,
		ctx,
		owner,
		credentialId,
	}
}

test('accessGrant keys a credential grant by its id and uses the credential family presets', async () => {
	const t = await setup()
	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'credential',
			resource_id: t.credentialId,
			subject_type: 'user',
			username: 'guestuser',
			preset: 'use',
		},
		t.owner,
	)
	expect(granted.grant).toMatchObject({
		resource_type: 'credential',
		resource_id: t.credentialId,
		subject_id: t.guestId,
	})
	expect(granted.grant.permissions).toEqual(['secret:use'])

	const listed = await accessListCapability.handler(
		{ resource_type: 'credential', resource_id: t.credentialId },
		t.owner,
	)
	expect(listed.grants.map((grant) => grant.id)).toEqual([granted.grant.id])
})

test('accessGrant refuses a credential name, an unknown id, and a member without manage access', async () => {
	const t = await setup()
	for (const resourceId of ['apiKey', crypto.randomUUID()]) {
		const error = await accessGrantCapability
			.handler(
				{
					resource_type: 'credential',
					resource_id: resourceId,
					subject_type: 'user',
					username: 'guestuser',
					preset: 'use',
				},
				t.owner,
			)
			.then(
				() => null,
				(caught: unknown) => caught,
			)
		expect(error).toBeInstanceOf(McpCallerError)
		expect(String(error)).toMatch(/credential_id from secretList/)
	}

	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'credential',
				resource_id: t.credentialId,
				subject_type: 'user',
				username: 'guestuser',
				preset: 'use',
			},
			t.ctx(t.memberId, 'memberuser', 'member'),
		),
	).rejects.toThrow(/secret:manage_access/)
})

test('an integration name shared by an OAuth connection and an MCP server is refused as a grant target, and listing by that name shows grants on both', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
			 VALUES (?, 'google', 'google', 'client-id', 'https://oauth2.example.com/token', 'pkce')`,
		)
		.bind(t.orgId)
		.run()
	await t.db
		.prepare(
			`INSERT INTO user_integrations (user_id, name, app_slug) VALUES (?, 'shared', 'google')`,
		)
		.bind(t.orgId)
		.run()
	const serverId = crypto.randomUUID()
	await t.db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES (?, ?, 'shared', 'https://mcp.example.com')`,
		)
		.bind(serverId, t.orgId)
		.run()
	const connection = await t.db
		.prepare(`SELECT id FROM user_integrations WHERE name = 'shared'`)
		.first<{ id: string }>()

	for (const create of [
		() =>
			accessGrantCapability.handler(
				{
					resource_type: 'integration',
					resource_id: 'shared',
					subject_type: 'user',
					username: 'guestuser',
					preset: 'use',
				},
				t.owner,
			),
		() =>
			inviteCreateCapability.handler(
				{
					kind: 'grant',
					username: 'memberuser',
					resource_type: 'integration',
					resource_id: 'shared',
					preset: 'use',
				},
				t.owner,
			),
	]) {
		const error = await create().then(
			() => null,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(McpCallerError)
		expect((error as Error).message).toMatch(/more than one integration/)
	}

	const granted = []
	for (const resourceId of [connection?.id ?? '', serverId]) {
		const { grant } = await accessGrantCapability.handler(
			{
				resource_type: 'credential',
				resource_id: resourceId,
				subject_type: 'user',
				username: 'guestuser',
				preset: 'use',
			},
			t.owner,
		)
		granted.push(grant.id)
	}
	const listed = await accessListCapability.handler(
		{ resource_type: 'integration', resource_id: 'shared' },
		t.owner,
	)
	expect(listed.grants.map((grant) => grant.id).sort()).toEqual(granted.sort())
})

test('deleting a credential revokes its grants and pending invites, and a recreate starts with none', async () => {
	const t = await setup()
	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'credential',
			resource_id: t.credentialId,
			subject_type: 'user',
			username: 'guestuser',
			preset: 'use',
		},
		t.owner,
	)
	const invited = await inviteCreateCapability.handler(
		{
			kind: 'grant',
			username: 'memberuser',
			resource_type: 'credential',
			resource_id: t.credentialId,
			preset: 'use',
		},
		t.owner,
	)
	expect(invited.invite).toMatchObject({
		resource_type: 'credential',
		resource_id: t.credentialId,
	})

	await deleteSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'apiKey',
		audit: null,
	})
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'apiKey',
		value: 'recreated-value',
		audit: null,
	})

	await expect(
		inviteAcceptCapability.handler(
			{ token: invited.token },
			t.ctx(t.memberId, 'memberuser', 'owner', {
				id: t.memberId,
				slug: 'memberuser',
			}),
		),
	).rejects.toThrow(/invite was revoked/)

	await expect(
		accessRevokeCapability.handler({ grant_id: granted.grant.id }, t.owner),
	).rejects.toThrow(/Grant was not found/)
	const listed = await accessListCapability.handler(
		{ resource_type: 'credential' },
		t.owner,
	)
	expect(listed.grants).toEqual([])
})
