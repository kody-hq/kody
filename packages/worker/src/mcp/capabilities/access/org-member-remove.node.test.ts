import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { orgMemberRemoveCapability } from './org-members.ts'

test('orgMemberRemove revokes org credentials and disconnects own-login integrations', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const orgId = ownerIdFromStored('org-remove-member')
	const ownerId = testStableUserIdFromEmail('remove-owner@example.com')
	const memberId = testStableUserIdFromEmail('remove-member@example.com')
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, 'remove-org', 'Remove', 'free', 'public', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, memberId, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-remove', ?, ?, 'team token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(memberId, orgId, ts, ts, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, client_id, token_url, flow,
				extra_authorize_params_json, created_at, updated_at
			) VALUES (
				?, 'github', 'github', 'client', 'https://example.com/token', 'confidential',
				'{}', ?, ?
			)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, description, scopes_json, required_hosts_json,
				access_token_encrypted, refresh_token_encrypted, connected_by_user_id,
				connected_at, created_at, updated_at
			) VALUES (
				?, 'github', 'github', '', '[]', '[]',
				'cipher', 'refresh', ?,
				?, ?, ?
			)`,
		)
		.bind(orgId, memberId, ts, ts, ts)
		.run()

	const result = await orgMemberRemoveCapability.handler(
		{ user_id: memberId },
		{
			env: { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(ownerId),
					email: 'remove-owner@example.com',
					displayName: 'Owner',
				},
				orgBinding: {
					org: { id: orgId, slug: 'remove-org' },
					role: 'owner',
				},
			}),
		},
	)
	expect(result).toEqual({ user_id: memberId, removed: true })

	const membership = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, memberId)
		.first<{ deleted_at: string | null }>()
	expect(membership?.deleted_at).toBeTruthy()
	const token = await db
		.prepare(`SELECT revoked_at FROM api_tokens WHERE id = 'token-remove'`)
		.first<{ revoked_at: string | null }>()
	expect(token?.revoked_at).toBeTruthy()
	const integration = await db
		.prepare(
			`SELECT access_token_encrypted FROM user_integrations
			 WHERE user_id = ? AND name = 'github'`,
		)
		.bind(orgId)
		.first<{ access_token_encrypted: string | null }>()
	expect(integration?.access_token_encrypted).toBeNull()
	const owner = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, ownerId)
		.first<{ deleted_at: string | null }>()
	expect(owner?.deleted_at).toBeNull()
})

test('orgMemberRemove retries credential revoke after the membership is already tombstoned', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const orgId = ownerIdFromStored('org-remove-retry')
	const ownerId = testStableUserIdFromEmail('retry-owner@example.com')
	const memberId = testStableUserIdFromEmail('retry-member@example.com')
	const ts = '2026-01-01T00:00:00.000Z'
	const deletedAt = '2026-10-01T12:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, 'retry-org', 'Retry', 'free', 'public', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', ?, NULL), (?, ?, 'member', ?, ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, memberId, ts, deletedAt)
		.run()
	await db
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-retry', ?, ?, 'team token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(memberId, orgId, ts, ts, ts, ts)
		.run()

	const result = await orgMemberRemoveCapability.handler(
		{ user_id: memberId },
		{
			env: { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(ownerId),
					email: 'retry-owner@example.com',
					displayName: 'Owner',
				},
				orgBinding: {
					org: { id: orgId, slug: 'retry-org' },
					role: 'owner',
				},
			}),
		},
	)
	expect(result).toEqual({ user_id: memberId, removed: true })
	const token = await db
		.prepare(`SELECT revoked_at FROM api_tokens WHERE id = 'token-retry'`)
		.first<{ revoked_at: string | null }>()
	expect(token?.revoked_at).toBe(deletedAt)
	const owner = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, ownerId)
		.first<{ deleted_at: string | null }>()
	expect(owner?.deleted_at).toBeNull()
})

test('a non-owner cannot resume offboarding of a tombstoned owner', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const orgId = ownerIdFromStored('org-owner-retry')
	const ownerId = testStableUserIdFromEmail('tomb-owner@example.com')
	const memberId = testStableUserIdFromEmail('tomb-member@example.com')
	const ts = '2026-01-01T00:00:00.000Z'
	const deletedAt = '2026-10-01T12:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, 'owner-retry', 'Owners', 'free', 'public', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', ?, ?), (?, ?, 'member', ?, NULL)`,
		)
		.bind(orgId, ownerId, ts, deletedAt, orgId, memberId, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES (
				'grant-member-delete', ?, 'org', ?, 'user', ?, ?, ?, ?
			)`,
		)
		.bind(orgId, orgId, memberId, ownerId, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-member-delete', 'member:delete')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-owner-retry', ?, ?, 'owner token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(ownerId, orgId, ts, ts, ts, ts)
		.run()

	await expect(
		orgMemberRemoveCapability.handler(
			{ user_id: ownerId },
			{
				env: { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env,
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://heykody.dev',
					user: {
						userId: personIdFromStored(memberId),
						email: 'tomb-member@example.com',
						displayName: 'Member',
					},
					orgBinding: {
						org: { id: orgId, slug: 'owner-retry' },
						role: 'member',
					},
				}),
			},
		),
	).rejects.toThrow(/Only an Owner can remove an Owner/)
	const token = await db
		.prepare(`SELECT revoked_at FROM api_tokens WHERE id = 'token-owner-retry'`)
		.first<{ revoked_at: string | null }>()
	expect(token?.revoked_at).toBeNull()
})
