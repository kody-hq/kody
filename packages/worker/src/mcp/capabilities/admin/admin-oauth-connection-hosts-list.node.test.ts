import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminOauthConnectionHostsListCapability } from './admin-oauth-connection-hosts-list.ts'

const orgId = testStableUserIdFromEmail('ale@example.com')

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite.exec(`
		INSERT INTO orgs (id, slug, created_at, updated_at)
		VALUES ('${orgId}', 'ale', '2026-10-01', '2026-10-01');
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow)
		VALUES ('${orgId}', 'dropbox', 'dropbox', 'dbx-client-id-never-shown',
			'https://api.dropboxapi.com/oauth2/token', 'https://api.dropboxapi.com', 'pkce');
		INSERT INTO platform_oauth_apps (
			slug, provider, client_id, token_url, authorize_url, flow, required_hosts_json
		) VALUES ('github-platform', 'github', 'gh-client',
			'https://github.com/login/oauth/access_token',
			'https://github.com/login/oauth/authorize', 'confidential', '["api.github.com"]');
		INSERT INTO user_integrations (
			id, user_id, name, app_slug, platform_app_slug, required_hosts_json,
			access_token_encrypted, connected_at, updated_at, deleted_at
		) VALUES
			('cred-dbx', '${orgId}', 'dropbox', 'dropbox', NULL,
				'["api.dropboxapi.com","content.dropboxapi.com","notify.dropboxapi.com"]',
				'ct-token-never-shown', '2026-10-02', '2026-10-03', NULL),
			('cred-gh', '${orgId}', 'github', NULL, 'github-platform', '[]',
				NULL, NULL, '2026-10-03', NULL),
			('cred-gone', '${orgId}', 'dropbox-old', 'dropbox', NULL, '[]',
				NULL, NULL, '2026-10-03', '2026-10-04');
	`)
	const db = createD1FromSqlite(sqlite)
	const ctx = (roles: Array<string>) => ({
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
	})
	return { ctx }
}

test('adminOauthConnectionHostsList rejects non-admins', async () => {
	const { ctx } = setup()
	await expect(
		adminOauthConnectionHostsListCapability.handler({ orgId }, ctx(['user'])),
	).rejects.toThrow('lacks required role "admin"')
})

test('adminOauthConnectionHostsList reports hosts and status, never a value', async () => {
	const { ctx } = setup()
	const all = await adminOauthConnectionHostsListCapability.handler(
		{ org: '@ale' },
		ctx(['admin']),
	)
	expect(
		all.connections.map(({ name, lane, hosts, appHosts }) => ({
			name,
			lane,
			hosts,
			appHosts,
		})),
	).toEqual([
		{
			name: 'dropbox',
			lane: 'user',
			hosts: [
				'api.dropboxapi.com',
				'content.dropboxapi.com',
				'notify.dropboxapi.com',
			],
			appHosts: [],
		},
		{
			name: 'github',
			lane: 'platform',
			hosts: [],
			appHosts: ['api.github.com'],
		},
	])
	const serialized = JSON.stringify(all)
	expect(serialized).not.toContain('never-shown')

	const dropbox = await adminOauthConnectionHostsListCapability.handler(
		{ orgId, provider: 'Dropbox' },
		ctx(['admin']),
	)
	expect(dropbox.connections.map((connection) => connection.name)).toEqual([
		'dropbox',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminOauthConnectionHostsList',
			result: 'success',
			reason: `org_id=${orgId};provider=Dropbox;returned=1`,
		}),
	)
})
