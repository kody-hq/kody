import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

// These tests assert real `audit_events` rows written through the actual
// audit pipeline, so opt out of the shared audit-log-spy setup mock.
vi.unmock('#worker/audit-log.ts')
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { getPlatformOauthAppClientSecret } from '#worker/integrations/platform-apps.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { adminPlatformOauthAppDeleteCapability } from './admin-platform-oauth-app-delete.ts'
import { adminPlatformOauthAppListCapability } from './admin-platform-oauth-app-list.ts'
import { adminPlatformOauthAppSaveCapability } from './admin-platform-oauth-app-save.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)
const auditMigrationsDirectory = new URL(
	'../../../../audit-migrations/',
	import.meta.url,
)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const auditSqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(auditSqlite, auditMigrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('admin-user-1'),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	} as CapabilityContext
	return { sqlite, auditSqlite, env, ctx }
}

const saveInput = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	clientSecret: 'platform-github-client-secret-value',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	apiBaseUrl: 'https://api.github.com',
	flow: 'confidential' as const,
	allowedScopes: ['repo', 'read:user'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com'],
}

test('save/list/delete platform OAuth apps never expose the client secret and write audit rows', async () => {
	const { auditSqlite, ctx, env } = createHarness()

	const saved = await adminPlatformOauthAppSaveCapability.handler(
		saveInput,
		ctx,
	)
	expect(saved.app).toMatchObject({
		slug: 'github',
		clientId: 'platform-github-client-id',
		enabled: true,
		visibility: 'draft',
	})
	expect(JSON.stringify(saved)).not.toContain(
		'platform-github-client-secret-value',
	)

	const published = await adminPlatformOauthAppSaveCapability.handler(
		{
			slug: 'github',
			clientId: saveInput.clientId,
			tokenUrl: saveInput.tokenUrl,
			authorizeUrl: saveInput.authorizeUrl,
			flow: 'confidential',
			visibility: 'published',
		},
		ctx,
	)
	expect(published.app).toMatchObject({
		enabled: true,
		visibility: 'published',
	})

	const disabled = await adminPlatformOauthAppSaveCapability.handler(
		{
			slug: 'github',
			clientId: saveInput.clientId,
			tokenUrl: saveInput.tokenUrl,
			authorizeUrl: saveInput.authorizeUrl,
			flow: 'confidential',
			enabled: false,
		},
		ctx,
	)
	expect(disabled.app.enabled).toBe(false)
	// Disable is independent of visibility.
	expect(disabled.app.visibility).toBe('published')
	await expect(
		getPlatformOauthAppClientSecret({
			db: env.APP_DB,
			env,
			slug: 'github',
		}),
	).resolves.toBe('platform-github-client-secret-value')

	const listed = await adminPlatformOauthAppListCapability.handler({}, ctx)
	expect(listed.apps).toHaveLength(1)
	expect(listed.apps[0]).toMatchObject({
		slug: 'github',
		hasClientSecret: true,
	})
	expect(JSON.stringify(listed)).not.toContain(
		'platform-github-client-secret-value',
	)

	const deleted = await adminPlatformOauthAppDeleteCapability.handler(
		{ slug: 'github' },
		ctx,
	)
	expect(deleted).toEqual({ deleted: true })

	const auditActions = auditSqlite
		.prepare('SELECT action, result FROM audit_events ORDER BY id ASC')
		.all() as Array<{ action: string; result: string }>
	expect(auditActions).toEqual([
		{ action: 'adminPlatformOauthAppSave', result: 'success' },
		{ action: 'adminPlatformOauthAppSave', result: 'success' },
		{ action: 'adminPlatformOauthAppSave', result: 'success' },
		{ action: 'adminPlatformOauthAppList', result: 'success' },
		{ action: 'adminPlatformOauthAppDelete', result: 'success' },
	])
})

test('delete refuses while connections exist and records the failure in the audit log', async () => {
	const { sqlite, auditSqlite, ctx } = createHarness()
	await adminPlatformOauthAppSaveCapability.handler(saveInput, ctx)
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug
			) VALUES (?, ?, NULL, ?)`,
		)
		.run('user-1', 'github', 'github')

	await expect(
		adminPlatformOauthAppDeleteCapability.handler({ slug: 'github' }, ctx),
	).rejects.toThrow('still has 1 user connection')

	const listed = await adminPlatformOauthAppListCapability.handler({}, ctx)
	expect(listed.apps[0]?.connectionCount).toBe(1)

	const failures = auditSqlite
		.prepare(
			`SELECT action FROM audit_events WHERE result = 'failure' ORDER BY id ASC`,
		)
		.all() as Array<{ action: string }>
	expect(failures).toEqual([{ action: 'adminPlatformOauthAppDelete' }])
})

test('enabling a confidential app without a client secret is an McpCallerError with audit failure', async () => {
	const { ctx, auditSqlite } = createHarness()
	await expect(
		adminPlatformOauthAppSaveCapability.handler(
			{
				slug: 'github',
				clientId: saveInput.clientId,
				clientSecret: null,
				tokenUrl: saveInput.tokenUrl,
				authorizeUrl: saveInput.authorizeUrl,
				flow: 'confidential',
			},
			ctx,
		),
	).rejects.toBeInstanceOf(McpCallerError)

	const failures = auditSqlite
		.prepare(
			`SELECT action, result FROM audit_events WHERE result = 'failure' ORDER BY id ASC`,
		)
		.all() as Array<{ action: string; result: string }>
	expect(failures).toEqual([
		{ action: 'adminPlatformOauthAppSave', result: 'failure' },
	])
})
