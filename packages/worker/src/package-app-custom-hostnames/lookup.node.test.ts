import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	isPackageAppCustomHostnameVerified,
	lookupPackageAppCustomHostname,
	lookupVerifiedAppCustomHostnameForPackage,
	normalizeCustomHostname,
	pickPrimaryVerifiedAppCustomHostname,
} from './lookup.ts'

const migrationSql = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../migrations/0133-package-app-custom-hostnames.sql',
	),
	'utf8',
)

function createDb() {
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
	return createD1FromSqlite(sqlite)
}

test('normalizeCustomHostname lowercases and rejects non-hostnames', () => {
	expect(normalizeCustomHostname(' App.Customer.Example. ')).toBe(
		'app.customer.example',
	)
	expect(normalizeCustomHostname('app.customer.example:443')).toBe(
		'app.customer.example',
	)
	expect(normalizeCustomHostname('app.customer.example.')).toBe(
		'app.customer.example',
	)
	expect(normalizeCustomHostname('localhost')).toBeNull()
	expect(normalizeCustomHostname('not a host')).toBeNull()
	expect(normalizeCustomHostname('')).toBeNull()
})

test('verified custom hostnames require active hostname and certificate', () => {
	expect(
		isPackageAppCustomHostnameVerified({
			hostnameStatus: 'active',
			sslStatus: 'active',
		}),
	).toBe(true)
	expect(
		isPackageAppCustomHostnameVerified({
			hostnameStatus: 'active',
			sslStatus: 'pending_validation',
		}),
	).toBe(false)
	expect(
		isPackageAppCustomHostnameVerified({
			hostnameStatus: 'pending',
			sslStatus: 'active',
		}),
	).toBe(false)
})

test('lookup resolves a verified app binding and ignores unverified or org rows for package handoff', async () => {
	const db = createDb()
	const now = '2026-10-13T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at) VALUES (?, 'pkg-owner', NULL, NULL)`,
		)
		.bind('org-owner')
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at) VALUES ('pkg-owner', 'org-owner', 'org-owner', ?)`,
		)
		.bind(now)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, deleted_at)
			 VALUES ('pkg-demo', 'org-owner', '@pkg-owner/demo', 'demo', NULL)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at) VALUES ('org-team', 'team', NULL, NULL)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				hostname_status, ssl_status, verified_at, created_at, updated_at
			) VALUES (?, ?, 'app', 'pkg-demo', NULL, 'active', 'active', ?, ?, ?)`,
		)
		.bind('row-app', 'app.customer-test.example', now, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				hostname_status, ssl_status, created_at, updated_at
			) VALUES ('row-pending', 'pending.customer-test.example', 'app', 'pkg-demo', NULL, 'pending', 'pending', ?, ?)`,
		)
		.bind(now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				hostname_status, ssl_status, created_at, updated_at
			) VALUES ('row-org', 'org.customer-test.example', 'org', NULL, 'org-team', 'active', 'active', ?, ?)`,
		)
		.bind(now, now)
		.run()

	await expect(
		lookupPackageAppCustomHostname({
			db,
			hostname: 'APP.Customer-Test.Example',
		}),
	).resolves.toEqual({
		hostname: 'app.customer-test.example',
		bindingKind: 'app',
		packageId: 'pkg-demo',
		orgId: null,
		username: 'pkg-owner',
		kodyId: 'demo',
		hostnameStatus: 'active',
		sslStatus: 'active',
		verified: true,
	})

	const pending = await lookupPackageAppCustomHostname({
		db,
		hostname: 'pending.customer-test.example',
	})
	expect(pending?.verified).toBe(false)
	expect(pending?.kodyId).toBe('demo')

	const org = await lookupPackageAppCustomHostname({
		db,
		hostname: 'org.customer-test.example',
	})
	expect(org).toMatchObject({
		bindingKind: 'org',
		packageId: null,
		orgId: 'org-team',
		username: 'team',
		kodyId: null,
		verified: true,
	})

	await expect(
		lookupPackageAppCustomHostname({ db, hostname: 'missing.example' }),
	).resolves.toBeNull()

	await expect(
		lookupVerifiedAppCustomHostnameForPackage({
			db,
			username: 'Pkg-Owner',
			kodyId: 'demo',
		}),
	).resolves.toMatchObject({
		hostname: 'app.customer-test.example',
		bindingKind: 'app',
		verified: true,
		kodyId: 'demo',
		username: 'pkg-owner',
	})

	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				hostname_status, ssl_status, verified_at, created_at, updated_at
			) VALUES (?, ?, 'app', 'pkg-demo', NULL, 'active', 'active', ?, ?, ?)`,
		)
		.bind(
			'row-app-zeta',
			'zeta.customer-test.example',
			now,
			'2026-10-14T00:00:00.000Z',
			'2026-10-14T00:00:00.000Z',
		)
		.run()
	await expect(
		lookupVerifiedAppCustomHostnameForPackage({
			db,
			username: 'pkg-owner',
			kodyId: 'demo',
		}),
	).resolves.toMatchObject({
		hostname: 'app.customer-test.example',
	})
	expect(
		pickPrimaryVerifiedAppCustomHostname([
			{
				hostname: 'zeta.customer-test.example',
				hostnameStatus: 'active',
				sslStatus: 'active',
			},
			{
				hostname: 'app.customer-test.example',
				hostnameStatus: 'active',
				sslStatus: 'active',
			},
		]),
	).toBe('app.customer-test.example')

	// A retired handle that sorts first must not replace the live org slug.
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at) VALUES ('aaa-retired', 'org-owner', 'org-owner', ?)`,
		)
		.bind(now)
		.run()
	await expect(
		lookupPackageAppCustomHostname({
			db,
			hostname: 'app.customer-test.example',
		}),
	).resolves.toMatchObject({ username: 'pkg-owner' })
})

test('migration rejects mixed-case hostnames and crossed binding columns', () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (id TEXT PRIMARY KEY);
		CREATE TABLE saved_packages (id TEXT PRIMARY KEY);
	`)
	sqlite.exec(migrationSql)
	sqlite.prepare(`INSERT INTO saved_packages (id) VALUES ('pkg')`).run()
	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id, created_at, updated_at
				) VALUES ('bad-case', 'App.Example', 'app', 'pkg', NULL, 't', 't')`,
			)
			.run(),
	).toThrow(/CHECK/i)
	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id, created_at, updated_at
				) VALUES ('crossed', 'org.example', 'app', 'pkg', 'org-1', 't', 't')`,
			)
			.run(),
	).toThrow(/CHECK/i)
	sqlite
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id, created_at, updated_at
			) VALUES ('ok', 'app.example', 'app', 'pkg', NULL, 't', 't')`,
		)
		.run()
	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id, created_at, updated_at
				) VALUES ('dup', 'app.example', 'app', 'pkg', NULL, 't', 't')`,
			)
			.run(),
	).toThrow(/UNIQUE/i)
})
