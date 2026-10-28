import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { adminOrgGetCapability, adminOrgDetailSchema } from './admin-org-get.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const adminId = testStableUserIdFromEmail('org-admin@example.com')
const orgId = testStableUserIdFromEmail('archived-org@example.com')

function createDeletedOrgDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, created_at, updated_at, deleted_at,
				deleting_at
			) VALUES (?, 'archived-team', 'Archived Team', 'standard',
				'2026-01-01', '2026-01-01', '2026-01-04T00:00:00.000Z',
				'2026-01-03T00:00:00.000Z')`,
		)
		.run(orgId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function callerFor(roles: Array<'admin' | 'user'>) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(adminId),
			email: 'org-admin@example.com',
			displayName: 'Org Admin',
			roles,
		},
	})
}

test('adminOrgGet is admin-only and resolves deleted organizations by slug and id', async () => {
	const { db } = createDeletedOrgDb()
	const userCaller = callerFor(['user'])
	const adminCaller = callerFor(['admin'])
	await expect(
		assertCallerCanAccessCapability(userCaller, adminOrgGetCapability),
	).rejects.toThrow('lacks required role "admin"')
	await assertCallerCanAccessCapability(adminCaller, adminOrgGetCapability)

	const ctx = {
		env: { APP_DB: db } as Env,
		callerContext: adminCaller,
	}
	const bySlug = await adminOrgGetCapability.handler(
		{ org: '@archived-team' },
		ctx as never,
	)
	expect(adminOrgDetailSchema.parse(bySlug)).toMatchObject({
		org: { id: orgId, slug: 'archived-team' },
		softDelete: {
			deletedAt: '2026-01-04T00:00:00.000Z',
			restoreDeadline: '2026-02-03T00:00:00.000Z',
		},
	})
	const byId = await adminOrgGetCapability.handler({ orgId }, ctx as never)
	expect(byId).toMatchObject({ org: { id: orgId, slug: 'archived-team' } })
})
