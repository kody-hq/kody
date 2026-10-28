/**
 * The website credential page keeps full placement edits after widening and
 * inject changes became website-only for code-running callers.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { setCredentialPlacement } from '#app/credential-placement-mutation.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { credentialUpdateCapability } from '#mcp/capabilities/secrets/credential-update.ts'
import { secretListCapability } from '#mcp/capabilities/secrets/secret-list.ts'
import { secretSetCapability } from '#mcp/capabilities/secrets/secret-set.ts'

const now = '2026-10-12T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	for (const [index, [stableUserId, username]] of [
		[ownerId, 'owneruser'],
		[memberId, 'memberuser'],
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
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const ctx = (
		userId: string,
		username: string,
		role: OrgRole | null,
		scopes?: Array<OrgPermission>,
	) => ({
		env,
		openApiPrincipal: { kind: 'mcp' } as const,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			scopes,
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(ownerId), slug: 'owneruser' },
				role,
			},
		}),
	})
	const owner = ctx(ownerId, 'owneruser', 'owner')
	const member = ctx(memberId, 'memberuser', 'member')
	const ownerReadOnlyToken = ctx(ownerId, 'owneruser', 'owner', [
		'secret:read',
		'secret:use',
	])
	const entry = async (name: string) =>
		await db
			.prepare(
				`SELECT e.id, e.kind, e.allowed_hosts, e.config_json, e.provider, e.inject_json,
					e.placement_json, e.encrypted_value, e.updated_at
				 FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
				 WHERE b.user_id = ? AND b.scope = 'user' AND e.name = ? AND e.deleted_at IS NULL`,
			)
			.bind(ownerId, name)
			.first<{
				id: string
				kind: string
				allowed_hosts: string
				config_json: string | null
				provider: string | null
				inject_json: string
				placement_json: string | null
				encrypted_value: string
				updated_at: string
			}>()
	const audits = async (action: string) => {
		const { results } = await auditDb
			.prepare(
				`SELECT resource_id, details_json FROM org_audit_events WHERE action = ? ORDER BY rowid`,
			)
			.bind(action)
			.all<{ resource_id: string; details_json: string }>()
		return results.map((row) => ({
			resourceId: row.resource_id,
			details: JSON.parse(row.details_json) as Record<string, unknown>,
		}))
	}
	const set = (input: Record<string, unknown>, as = owner) =>
		secretSetCapability.handler({ scope: 'user', ...input } as never, as)
	return { sqlite, owner, member, ownerReadOnlyToken, entry, audits, set }
}

test('the MCP api tool and the website keep full placement and inject edits', async () => {
	const t = await setup()
	await t.set({ name: 'apiKey', value: 'sk_value' })
	const listed = await secretListCapability.handler({ scope: 'user' }, t.owner)
	const credentialId = listed.secrets.find(
		(secret) => secret.name === 'apiKey',
	)!.credential_id
	await expect(
		credentialUpdateCapability.handler(
			{
				credential_id: credentialId,
				inject: { kind: 'query', param: 'api_key' },
				placement: { headers: true, query: true },
			},
			t.owner,
		),
	).resolves.toMatchObject({
		inject: { kind: 'query', param: 'api_key' },
		placement: { headers: true, query: true },
	})
	const website = await setCredentialPlacement({
		env: t.owner.env,
		user: {
			request: t.owner.callerContext.request,
			mcpUser: t.owner.callerContext.user,
		} as never,
		body: {
			credentialId,
			placement: { headers: true, query: true, body: true },
		},
	})
	expect(website).toMatchObject({
		data: { ok: true, changed: true, placement: { body: true } },
	})
	expect(JSON.parse((await t.entry('apiKey'))!.placement_json!)).toEqual({
		headers: true,
		query: true,
		body: true,
	})
})
