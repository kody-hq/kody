import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { lockSecretToPackage, saveSecret } from './service.ts'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { sqlite, env }
}

function seedPackage(
	sqlite: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.kodyId,
			input.kodyId,
			'',
			`source-${input.id}`,
		)
}

test('lockSecretToPackage adds a package grant and rejects unknown packages', async () => {
	const { sqlite, env } = createHarness()
	const userId = ownerIdFromStored('user-secret-lock')
	seedPackage(sqlite, { id: 'pkg-notes', userId, kodyId: 'notes' })
	seedPackage(sqlite, { id: 'pkg-mail', userId, kodyId: 'mail' })

	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'openai-api-key',
		value: 'sk-test',
		audit: null,
	})

	const locked = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
		audit: null,
	})
	expect(locked).toMatchObject({
		name: 'openai-api-key',
		scope: 'user',
		allowedPackages: ['pkg-notes'],
	})

	const grantedAgain = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-mail',
		audit: null,
	})
	expect(grantedAgain.allowedPackages).toEqual(['pkg-mail', 'pkg-notes'])

	const idempotent = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
		audit: null,
	})
	expect(idempotent.allowedPackages).toEqual(['pkg-mail', 'pkg-notes'])

	await expect(
		lockSecretToPackage({
			env,
			userId,
			name: 'openai-api-key',
			packageId: 'missing-package',
			audit: null,
		}),
	).rejects.toThrow('Saved package not found for this user.')
	await expect(
		lockSecretToPackage({
			env,
			userId,
			name: 'missing-secret',
			packageId: 'pkg-notes',
			audit: null,
		}),
	).rejects.toThrow('Secret not found for this scope.')
})
