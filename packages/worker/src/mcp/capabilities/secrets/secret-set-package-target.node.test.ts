/**
 * secretSet with `package_id` creates a package-scoped secret from execute,
 * the API, or the CLI, gated like the website: the package must belong to the
 * caller's org and the caller needs secret create permission.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { findSecret, resolveSecret } from '#mcp/secrets/service.ts'
import { secretSetCapability } from './secret-set.ts'

const now = '2026-11-19T00:00:00.000Z'

async function setup(role: OrgRole = 'owner') {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')!
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (1, 'owneruser', 'owneruser@example.com', 'h', ?, ?, ?)`,
		)
		.bind(now, now, ownerId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneruser',
		createdAt: now,
	})
	const org = ownerIdFromStored(ownerId)
	for (const [id, userId, name] of [
		['pkg-rooms', org, '@owneruser/rooms'],
		['pkg-elsewhere', 'other-org', '@other/rooms'],
	]) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, tags_json, search_text,
					source_id, has_app, hidden, is_private, created_at, updated_at
				) VALUES (?, ?, ?, 'rooms', '', '[]', NULL, ?, 1, 0, 0, ?, ?)`,
			)
			.run(id, userId, name, `source-${id}`, now, now)
	}
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const ctx = {
		env,
		openApiPrincipal: { kind: 'mcp' } as const,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(ownerId),
				email: 'owneruser@example.com',
				displayName: 'owneruser',
				username: 'owneruser',
			},
			orgBinding: { org: { id: org, slug: 'owneruser' }, role },
		}),
	}
	return { ctx, env, org }
}

async function failure(promise: Promise<unknown>) {
	return await promise.then(
		() => {
			throw new Error('Expected secretSet to fail.')
		},
		(error: unknown) => error,
	)
}

test('secretSet with package_id outside a package run creates and updates a secret locked to that package', async () => {
	const { ctx, env, org } = await setup()
	const created = await secretSetCapability.handler(
		{
			name: 'roomsWakeKey',
			scope: 'package',
			package_id: 'pkg-rooms',
			value: 'first',
		},
		ctx,
	)
	expect(created).toMatchObject({ name: 'roomsWakeKey', scope: 'package' })
	await secretSetCapability.handler(
		{
			name: 'roomsWakeKey',
			scope: 'package',
			package_id: 'pkg-rooms',
			value: 'second',
		},
		ctx,
	)
	const inPackage = await findSecret({
		env,
		userId: org,
		name: 'roomsWakeKey',
		scope: 'package',
		storageContext: { sessionId: null, appId: null, packageId: 'pkg-rooms' },
	})
	expect(inPackage.found).toBe(true)
	const resolved = await resolveSecret({
		env,
		userId: org,
		name: 'roomsWakeKey',
		scope: 'package',
		storageContext: { sessionId: null, appId: null, packageId: 'pkg-rooms' },
	})
	expect(resolved.value).toBe('second')
	const asOrgKey = await findSecret({
		env,
		userId: org,
		name: 'roomsWakeKey',
		scope: 'user',
		storageContext: null,
	})
	expect(asOrgKey.found).toBe(false)
})

test('secretSet package_id must name a package in the caller org and needs scope package', async () => {
	const { ctx } = await setup()
	const elsewhere = await failure(
		secretSetCapability.handler(
			{
				name: 'roomsWakeKey',
				scope: 'package',
				package_id: 'pkg-elsewhere',
				value: 'x',
			},
			ctx,
		),
	)
	expect(elsewhere).toBeInstanceOf(McpCallerError)
	expect((elsewhere as Error).message).toBe(
		'Package "pkg-elsewhere" was not found in this org.',
	)
	const userScope = await failure(
		secretSetCapability.handler(
			{
				name: 'roomsWakeKey',
				scope: 'user',
				package_id: 'pkg-rooms',
				value: 'x',
			},
			ctx,
		),
	)
	expect((userScope as Error).message).toBe('package_id needs scope "package".')
	const noTarget = await failure(
		secretSetCapability.handler(
			{ name: 'roomsWakeKey', scope: 'package', value: 'x' },
			ctx,
		),
	)
	expect((noTarget as Error).message).toContain('Pass `package_id`')
})

test('secretSet package_id needs the same secret create permission as the website', async () => {
	const { ctx } = await setup('billing')
	const denied = await failure(
		secretSetCapability.handler(
			{
				name: 'roomsWakeKey',
				scope: 'package',
				package_id: 'pkg-rooms',
				value: 'x',
			},
			ctx,
		),
	)
	expect((denied as Error).message).toMatch(/Missing secret:(write|create)/)
})
