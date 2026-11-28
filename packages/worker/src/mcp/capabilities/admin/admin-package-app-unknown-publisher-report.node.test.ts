import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { buildPackageAppUnknownPublisherReport } from './admin-package-app-unknown-publisher-report.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

const now = '2026-11-28T00:00:00.000Z'

test('counts unknown-publisher apps without an Owner pick, split personal and team', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, stable_user_id, password_hash)
			 VALUES (1, 'ada', 'ada@example.com', 'user-ada', 'unused')`,
		)
		.run()
	const app = (
		id: string,
		ownerId: string,
		authority: { unknown: 0 | 1; runsAs?: string },
		hasApp = 1,
	) => {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (id, user_id, kody_id, name, description, source_id, has_app, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
			)
			.run(id, ownerId, id, `@x/${id}`, `source-${id}`, hasApp, now, now)
		sqlite
			.prepare(
				`INSERT INTO package_app_authority
				 (package_id, owner_id, runs_as_person_id, publisher_unknown, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, ownerId, authority.runsAs ?? null, authority.unknown, now)
	}
	app('personal', 'user-ada', { unknown: 1 })
	app('team', 'org-team', { unknown: 1 })
	app('picked', 'org-team', { unknown: 1, runsAs: 'user-ada' })
	app('known', 'org-team', { unknown: 0 })
	app('no-app', 'org-team', { unknown: 1 }, 0)

	expect(
		await buildPackageAppUnknownPublisherReport(createD1FromSqlite(sqlite)),
	).toEqual({ unknownPublisherApps: 2, personalOrgApps: 1, teamOrgApps: 1 })
})
