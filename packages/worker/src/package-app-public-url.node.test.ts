import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	resolvePackageAppRunLocations,
	resolvePublicPackageAppLocation,
} from '#worker/package-app-public-url.ts'

// These fixtures have no owner or package rows, so no profile package exists.
vi.mock('#worker/package-app-profile-host.ts', () => ({
	hasProfilePackageApp: async () => false,
}))

const migrationSql = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../migrations/0133-package-app-custom-hostnames.sql',
	),
	'utf8',
)

function createEnv(input?: {
	withHostname?: 'verified' | 'pending' | 'none'
	queries?: Array<string>
}) {
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
			description TEXT NOT NULL DEFAULT '',
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL DEFAULT '',
			has_app INTEGER NOT NULL DEFAULT 0,
			has_skills INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			is_private INTEGER NOT NULL DEFAULT 0,
			is_internet_visible INTEGER NOT NULL DEFAULT 0,
			locked_at TEXT,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
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
	const db = createD1FromSqlite(sqlite, { queries: input?.queries })
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
			`INSERT INTO saved_packages (id, user_id, name, kody_id, has_app, deleted_at)
			 VALUES
				('pkg-demo', 'org-owner', '@pkg-owner/demo', 'demo', 1, NULL),
				('pkg-plain', 'org-owner', '@pkg-owner/plain', 'plain', 1, NULL),
				('pkg-no-app', 'org-owner', '@pkg-owner/lib', 'lib', 0, NULL),
				('pkg-deleted', 'org-owner', '@pkg-owner/gone', 'gone', 1, ?)`,
		)
		.run(now)
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
		hostedUrl: 'https://demo--pkg-owner.kody.run/',
		appBasePath: '',
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
		hostedUrl: 'https://demo--pkg-owner.kody.run/',
		appBasePath: '',
	})
})

test('resolvePackageAppRunLocations loads every run package in one query and gives each its served app URL', async () => {
	const queries: Array<string> = []
	const env = createEnv({ withHostname: 'verified', queries })
	await expect(
		resolvePackageAppRunLocations({
			env,
			baseUrl: 'https://kody.codes',
			packageIds: [
				'pkg-demo',
				'pkg-plain',
				'pkg-demo',
				'pkg-no-app',
				'pkg-deleted',
				'pkg-missing',
				'pkg-plain',
			],
		}),
	).resolves.toEqual({
		'pkg-demo': { hostedUrl: 'https://app.example.com/', appBasePath: '' },
		'pkg-plain': {
			hostedUrl: 'https://plain--pkg-owner.kody.run/',
			appBasePath: '',
		},
		'pkg-no-app': { hostedUrl: null, appBasePath: null },
		'pkg-deleted': { hostedUrl: null, appBasePath: null },
		'pkg-missing': { hostedUrl: null, appBasePath: null },
	})
	expect(
		queries.filter((sql) => sql.includes('FROM saved_packages')),
	).toHaveLength(1)
})

test('resolvePackageAppRunLocations chunks large package id lists under the bound-parameter limit', async () => {
	const queries: Array<string> = []
	const env = createEnv({ withHostname: 'none', queries })
	const packageIds = [
		'pkg-demo',
		...Array.from({ length: 120 }, (_, index) => `pkg-missing-${index}`),
	]
	const locations = await resolvePackageAppRunLocations({
		env,
		baseUrl: 'https://kody.codes',
		packageIds,
	})
	expect(Object.keys(locations)).toHaveLength(packageIds.length)
	expect(locations['pkg-demo']).toEqual({
		hostedUrl: 'https://demo--pkg-owner.kody.run/',
		appBasePath: '',
	})
	expect(
		queries.filter((sql) => sql.includes('FROM saved_packages')),
	).toHaveLength(2)
})

test('resolvePublicPackageAppLocation never links the shared owner host path address', async () => {
	const env = createEnv({ withHostname: 'none' })
	const location = await resolvePublicPackageAppLocation({
		env,
		username: 'pkg-owner',
		kodyId: 'demo',
		restPath: '/inbox',
	})
	expect(location?.hostedUrl).toBe('https://demo--pkg-owner.kody.run/inbox')
	expect(location?.hostedUrl).not.toMatch(/^https:\/\/pkg-owner\.kody\.run\//)
	expect(location?.hostedUrl).not.toContain('/packages/')
})
