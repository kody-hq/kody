import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { buildPackageScopedSecretReport } from './admin-package-scoped-secret-report.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

test('package-scoped secret report counts only live package buckets with a value', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite.exec(`
		INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES ('pkg-a', 'org-1', '@one/a', 'a', '', 'src-a'),
			('pkg-b', 'org-2', '@two/b', 'b', '', 'src-b');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key, expires_at) VALUES
			('b-a', 'org-1', 'package', 'pkg-a', NULL),
			('b-gone', 'org-1', 'package', 'pkg-gone', NULL),
			('b-b', 'org-2', 'package', 'pkg-b', NULL),
			('b-expired', 'org-2', 'package', 'pkg-x', '2000-01-01T00:00:00.000Z'),
			('b-user', 'org-1', 'user', '', NULL);
		INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES
			('b-a', 'one', 'v'), ('b-a', 'two', 'v'), ('b-a', 'disconnected', ''),
			('b-gone', 'one', 'v'),
			('b-b', 'one', 'v'),
			('b-expired', 'one', 'v'),
			('b-user', 'one', 'v');
		UPDATE secret_entries SET deleted_at = '2026-01-01T00:00:00.000Z'
			WHERE bucket_id = 'b-b';
		INSERT INTO secret_entries (bucket_id, name, encrypted_value)
			VALUES ('b-b', 'live', 'v');
	`)

	const report = await buildPackageScopedSecretReport({
		db: createD1FromSqlite(sqlite),
		packageLimit: 2,
	})

	expect(report).toEqual({
		totals: { orgs: 2, packages: 3, secrets: 4, orphanedPackages: 1 },
		orgs: [
			{ orgId: 'org-1', packages: 2, secrets: 3 },
			{ orgId: 'org-2', packages: 1, secrets: 1 },
		],
		packagesTruncated: true,
		packages: [
			{ orgId: 'org-1', packageId: 'pkg-a', packageKodyId: 'a', secrets: 2 },
			{
				orgId: 'org-1',
				packageId: 'pkg-gone',
				packageKodyId: null,
				secrets: 1,
			},
		],
	})
})
