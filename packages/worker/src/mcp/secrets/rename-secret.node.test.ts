import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	listSecrets,
	renameSecret,
	resolveSecret,
	saveSecret,
} from './service.ts'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)
const userId = ownerIdFromStored('user-123')

async function createSecretEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return {
		sqlite,
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			COOKIE_SECRET: 'test-cookie-secret',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			...createInMemoryUserMeterEnv().env,
		},
	}
}

test('renameSecret persists a case-only name change and keeps the credential id', async () => {
	const { env, sqlite } = await createSecretEnv()
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'Henry',
		value: 'secret-value',
		audit: null,
	})
	const before = sqlite
		.prepare(`SELECT id, name FROM secret_entries WHERE name = 'Henry'`)
		.get() as { id: string; name: string }
	expect(before.name).toBe('Henry')

	const renamed = await renameSecret({
		env,
		userId,
		scope: 'user',
		fromName: 'Henry',
		toName: 'henry',
		audit: null,
	})
	expect(renamed.name).toBe('henry')

	const after = sqlite
		.prepare(`SELECT id, name FROM secret_entries`)
		.all() as Array<{ id: string; name: string }>
	expect(after).toEqual([{ id: before.id, name: 'henry' }])

	await expect(
		resolveSecret({ env, userId, name: 'henry', scope: 'user' }),
	).resolves.toMatchObject({ found: true, value: 'secret-value' })
	await expect(
		resolveSecret({ env, userId, name: 'Henry', scope: 'user' }),
	).resolves.toMatchObject({ found: false })
	await expect(listSecrets({ env, userId, scope: 'user' })).resolves.toEqual([
		expect.objectContaining({ name: 'henry', credentialId: before.id }),
	])
})

test('renameSecret refuses a destination that already exists with exact casing', async () => {
	const { env } = await createSecretEnv()
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'Alpha',
		value: 'a',
		audit: null,
	})
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'alpha',
		value: 'b',
		audit: null,
	})
	await expect(
		renameSecret({
			env,
			userId,
			scope: 'user',
			fromName: 'Alpha',
			toName: 'alpha',
			audit: null,
		}),
	).rejects.toThrow(/already exists/)
})
