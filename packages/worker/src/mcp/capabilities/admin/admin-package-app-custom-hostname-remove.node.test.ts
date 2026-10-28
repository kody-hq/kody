import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	adminPackageAppCustomHostnameRemoveCapability,
	adminPackageAppCustomHostnameRemoveInputSchema,
} from './admin-package-app-custom-hostname-remove.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite.exec(`
		INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		VALUES ('org-other', 'other-co', 'Other Co', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z');
		INSERT INTO package_app_custom_hostnames (
			id, hostname, binding_kind, package_id, org_id,
			cloudflare_hostname_id, cloudflare_zone_id,
			hostname_status, ssl_status, created_by_user_id,
			created_at, updated_at
		) VALUES (
			'row-abuse', 'phish.example.com', 'org', NULL, 'org-other',
			'cf-abuse', 'zonetest123', 'active', 'active', 'person-other',
			'2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z'
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createContext(roles: Array<string>, db: D1Database) {
	const adminStableUserId = testStableUserIdFromEmail('admin@example.com')
	const fetch = vi.fn(
		async (_url: string, _init?: RequestInit) =>
			new Response(
				JSON.stringify({ success: true, result: { id: 'cf-abuse' } }),
				{ status: 200 },
			),
	)
	return {
		fetch,
		ctx: {
			env: {
				APP_DB: db,
				PACKAGE_APP_BASE_URL: 'https://kody.run',
				PACKAGE_APP_ZONE_ID: 'zonetest123',
				CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
				fetcher: { fetch },
			} as unknown as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored(adminStableUserId),
					email: 'admin@example.com',
					displayName: 'admin',
					roles,
				},
			}),
		},
	}
}

function hostnameRowCount(sqlite: DatabaseSync) {
	return (
		sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM package_app_custom_hostnames WHERE hostname = 'phish.example.com'`,
			)
			.get() as { n: number }
	).n
}

test('admin custom hostname takedown requires a reason of at least 10 characters', () => {
	const schema = adminPackageAppCustomHostnameRemoveInputSchema
	expect(schema.safeParse({ hostname: 'phish.example.com' }).success).toBe(
		false,
	)
	expect(
		schema.safeParse({ hostname: 'phish.example.com', reason: '  short  ' })
			.success,
	).toBe(false)
	expect(
		schema.safeParse({
			hostname: 'phish.example.com',
			reason: 'phishing report from abuse inbox',
		}).success,
	).toBe(true)
})

test('admin custom hostname takedown: admin-only, deletes from Cloudflare and the DB, audits the reason', async () => {
	const { sqlite, db } = createMigratedDb()
	const reason = 'phishing report from abuse inbox'

	const user = createContext(['user'], db)
	await expect(
		adminPackageAppCustomHostnameRemoveCapability.handler(
			{ hostname: 'phish.example.com', reason },
			user.ctx,
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(user.fetch).not.toHaveBeenCalled()
	expect(hostnameRowCount(sqlite)).toBe(1)

	const admin = createContext(['admin'], db)
	await expect(
		adminPackageAppCustomHostnameRemoveCapability.handler(
			{ hostname: 'missing.example.com', reason },
			admin.ctx,
		),
	).rejects.toThrow('Custom hostname not found.')
	expect(admin.fetch).not.toHaveBeenCalled()

	const removed = await adminPackageAppCustomHostnameRemoveCapability.handler(
		{ hostname: 'Phish.Example.com.', reason },
		admin.ctx,
	)
	expect(removed).toEqual({
		ok: true,
		id: 'row-abuse',
		hostname: 'phish.example.com',
		binding_kind: 'org',
		org_id: 'org-other',
		package_id: null,
		hostname_status: 'active',
	})
	expect(admin.fetch).toHaveBeenCalledTimes(1)
	const [url, init] = admin.fetch.mock.calls[0] ?? []
	expect(init?.method).toBe('DELETE')
	expect(String(url)).toContain('/zones/zonetest123/custom_hostnames/cf-abuse')
	expect(hostnameRowCount(sqlite)).toBe(0)

	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminPackageAppCustomHostnameRemove',
			result: 'success',
			reason: expect.stringContaining(
				`hostname=phish.example.com;id=row-abuse;binding_kind=org;org_id=org-other;package_id=;reason=${reason}`,
			),
		}),
	)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminPackageAppCustomHostnameRemove:failure',
		'adminPackageAppCustomHostnameRemove:success',
	])
})
