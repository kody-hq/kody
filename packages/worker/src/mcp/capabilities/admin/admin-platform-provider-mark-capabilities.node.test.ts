import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

vi.unmock('#worker/audit-log.ts')
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeImagesBinding,
	tinyPngBytes,
} from '#worker/test-support/images-binding.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { adminPlatformProviderMarkDeleteCapability } from './admin-platform-provider-mark-delete.ts'
import { adminPlatformProviderMarkListCapability } from './admin-platform-provider-mark-list.ts'
import { adminPlatformProviderMarkSaveCapability } from './admin-platform-provider-mark-save.ts'

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
	const objects = new Map<string, Uint8Array>()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: {
			async put(key: string, bytes: Uint8Array) {
				objects.set(key, bytes)
			},
			async get(key: string) {
				return objects.has(key) ? { body: objects.get(key) } : null
			},
			async delete(key: string) {
				objects.delete(key)
			},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
	} as unknown as Env
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
	return { env, ctx, objects, auditSqlite }
}

test('save/list/delete provider marks store a fitted logo and write audit rows', async () => {
	const { ctx, auditSqlite } = createHarness()

	const saved = await adminPlatformProviderMarkSaveCapability.handler(
		{
			slug: 'Google',
			label: 'Google',
			aliases: ['accounts.google.com', 'googleapis.com'],
			logoBase64: bytesToBase64(tinyPngBytes),
		},
		ctx,
	)
	expect(saved.mark).toMatchObject({
		slug: 'google',
		label: 'Google',
	})
	expect(saved.mark.aliases).toEqual([])
	expect(saved.mark.logoPath).toMatch(/^\/integrations\/provider-marks\/google/)

	const listed = await adminPlatformProviderMarkListCapability.handler({}, ctx)
	expect(listed.marks).toHaveLength(1)
	expect(listed.marks[0]?.slug).toBe('google')

	const deleted = await adminPlatformProviderMarkDeleteCapability.handler(
		{ slug: 'google' },
		ctx,
	)
	expect(deleted).toEqual({ deleted: true })
	expect(
		(await adminPlatformProviderMarkListCapability.handler({}, ctx)).marks,
	).toEqual([])
	const auditActions = auditSqlite
		.prepare('SELECT action, result FROM audit_events ORDER BY id ASC')
		.all() as Array<{ action: string; result: string }>
	expect(auditActions).toEqual([
		{ action: 'adminPlatformProviderMarkSave', result: 'success' },
		{ action: 'adminPlatformProviderMarkList', result: 'success' },
		{ action: 'adminPlatformProviderMarkDelete', result: 'success' },
		{ action: 'adminPlatformProviderMarkList', result: 'success' },
	])
})

test('delete provider mark fails when logo storage is missing', async () => {
	const { ctx, env } = createHarness()
	await adminPlatformProviderMarkSaveCapability.handler(
		{
			slug: 'google',
			label: 'Google',
			logoBase64: bytesToBase64(tinyPngBytes),
		},
		ctx,
	)
	const missingStorageCtx: CapabilityContext = {
		...ctx,
		env: { ...env, COMMUNITY_ASSETS: undefined } as unknown as Env,
	}

	await expect(
		adminPlatformProviderMarkDeleteCapability.handler(
			{ slug: 'google' },
			missingStorageCtx,
		),
	).rejects.toThrow(McpCallerError)
	expect(
		(await adminPlatformProviderMarkListCapability.handler({}, ctx)).marks,
	).toHaveLength(1)
})
