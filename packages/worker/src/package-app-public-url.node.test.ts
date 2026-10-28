import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'

const migrationSql = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../migrations/0133-package-app-custom-hostnames.sql',
	),
	'utf8',
)

function createEnv(input?: { withHostname?: 'verified' | 'pending' | 'none' }) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT,
			suspended_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE handles (
			handle TEXT PRIMARY KEY,
			user_id TEXT,
			org_id TEXT,
			created_at TEXT NOT NULL
		);
	`)
	sqlite.exec(migrationSql)
	const db = createD1FromSqlite(sqlite)
	const now = '2026-10-25T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at) VALUES ('org-owner', 'pkg-owner', NULL, NULL)`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at) VALUES ('pkg-owner', 'org-owner', 'org-owner', ?)`,
		)
		.run(now)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, deleted_at)
			 VALUES ('pkg-demo', 'org-owner', '@pkg-owner/demo', 'demo', NULL)`,
		)
		.run()
	if (input?.withHostname === 'verified') {
		sqlite
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id,
					hostname_status, ssl_status, verified_at, created_at, updated_at
				) VALUES (
					'row-app', 'app.example.com', 'app', 'pkg-demo', NULL,
					'active', 'active', ?, ?, ?
				)`,
			)
			.run(now, now, now)
		sqlite
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id,
					hostname_status, ssl_status, verified_at, created_at, updated_at
				) VALUES (
					'row-app-zeta', 'zeta.example.com', 'app', 'pkg-demo', NULL,
					'active', 'active', ?, ?, ?
				)`,
			)
			.run(now, now, now)
	}
	if (input?.withHostname === 'pending') {
		sqlite
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id,
					hostname_status, ssl_status, created_at, updated_at
				) VALUES (
					'row-pending', 'pending.example.com', 'app', 'pkg-demo', NULL,
					'pending', 'pending', ?, ?
				)`,
			)
			.run(now, now)
	}
	return {
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		APP_DB: db,
	} as unknown as Env
}

test('resolvePublicPackageAppLocation uses a verified custom domain when present', async () => {
	const env = createEnv({ withHostname: 'verified' })
	await expect(
		resolvePublicPackageAppLocation({
			env,
			username: 'pkg-owner',
			kodyId: 'demo',
		}),
	).resolves.toEqual({
		hostedUrl: 'https://app.example.com/',
		appBasePath: '',
	})
})

test('resolvePublicPackageAppLocation falls back to kody.run when only pending hostnames exist', async () => {
	const env = createEnv({ withHostname: 'pending' })
	await expect(
		resolvePublicPackageAppLocation({
			env,
			username: 'pkg-owner',
			kodyId: 'demo',
		}),
	).resolves.toEqual({
		hostedUrl: 'https://pkg-owner.kody.run/demo',
		appBasePath: '/demo',
	})
})

test('resolvePublicPackageAppLocation falls back to kody.run when no custom hostname exists', async () => {
	const env = createEnv({ withHostname: 'none' })
	await expect(
		resolvePublicPackageAppLocation({
			env,
			username: 'pkg-owner',
			kodyId: 'demo',
		}),
	).resolves.toEqual({
		hostedUrl: 'https://pkg-owner.kody.run/demo',
		appBasePath: '/demo',
	})
})
