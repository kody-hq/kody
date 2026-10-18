import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { listCredentialProviderBindings } from './credential-provider-bindings.ts'

test('provider bindings list live bindings for the owner, sorted by provider', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	// Only the reader is under test; owner rows would add nothing.
	sqlite.exec('PRAGMA foreign_keys = OFF')
	await db
		.prepare(
			`INSERT INTO secret_provider_bindings
				(id, user_id, provider_id, package_id, door_secret_name, placement_json, deleted_at)
			VALUES
				('vault-2', 'org-a', 'onepassword', 'pkg-digest', 'OP_DOOR', '{"headers":true}', NULL),
				('vault-1', 'org-a', 'bitwarden', 'pkg-triage', 'BW_DOOR', NULL, NULL),
				('vault-3', 'org-a', 'aws', 'pkg-x', 'GONE', NULL, '2026-10-01T00:00:00Z'),
				('vault-4', 'org-b', 'aws', 'pkg-y', 'OTHER', NULL, NULL)`,
		)
		.run()

	const bindings = await listCredentialProviderBindings(db, 'org-a')

	expect(
		bindings.map(
			({ id, providerId, packageId, doorSecretName, placement }) => ({
				id,
				providerId,
				packageId,
				doorSecretName,
				placement,
			}),
		),
	).toEqual([
		{
			id: 'vault-1',
			providerId: 'bitwarden',
			packageId: 'pkg-triage',
			doorSecretName: 'BW_DOOR',
			placement: null,
		},
		{
			id: 'vault-2',
			providerId: 'onepassword',
			packageId: 'pkg-digest',
			doorSecretName: 'OP_DOOR',
			placement: { headers: true },
		},
	])
})
