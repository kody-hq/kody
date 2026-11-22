import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	clearCachedPackageAppCustomHostnames,
	invalidateCachedPackageAppCustomHostname,
	lookupCachedPackageAppCustomHostname,
} from './lookup-cache.ts'

const migrationSql = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../migrations/0133-package-app-custom-hostnames.sql',
	),
	'utf8',
)

afterEach(() => {
	vi.useRealTimers()
})

/**
 * Hand the next D1 read to the caller: it settles only when the test says so,
 * like a lookup whose request ended before D1 answered.
 */
function stallNextRead(db: D1Database) {
	let release!: (error: Error) => void
	const stalled = new Promise<never>((_, reject) => {
		release = reject
	})
	let armed = true
	const wrapped = new Proxy(db, {
		get(target, property, receiver) {
			if (property !== 'prepare') return Reflect.get(target, property, receiver)
			return (sql: string) => {
				const statement = target.prepare(sql)
				const bind = statement.bind.bind(statement)
				return Object.assign(Object.create(statement), {
					bind: (...values: Array<unknown>) => {
						const bound = bind(...values)
						return Object.assign(Object.create(bound), {
							first: () => {
								if (!armed) return bound.first()
								armed = false
								return stalled
							},
						})
					},
				})
			}
		},
	})
	return { db: wrapped, release }
}

async function insertActiveOrgHostname(db: D1Database) {
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'acme')`).run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'row-1', 'apps.example.com', 'org', NULL, 'org-1',
				'cf-1', 'zone', 'active', 'active', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()
}

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
	`)
	sqlite.exec(migrationSql)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('cached lookup returns the same mapping within the TTL and refreshes after invalidate', async () => {
	const { sqlite, db } = createDb()
	clearCachedPackageAppCustomHostnames(db)
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'acme')`).run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'row-1', 'apps.example.com', 'org', NULL, 'org-1',
				'cf-1', 'zone', 'active', 'active', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()

	const first = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'Apps.Example.com',
	})
	expect(first?.hostname).toBe('apps.example.com')
	expect(first?.verified).toBe(true)

	sqlite
		.prepare(
			`UPDATE package_app_custom_hostnames SET hostname_status = 'moved' WHERE id = 'row-1'`,
		)
		.run()
	const cached = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	expect(cached?.hostnameStatus).toBe('active')

	invalidateCachedPackageAppCustomHostname(db, 'apps.example.com')
	const refreshed = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	expect(refreshed?.hostnameStatus).toBe('moved')
	expect(refreshed?.verified).toBe(false)
})

test('clearCachedPackageAppCustomHostnames drops all isolate entries for a db', async () => {
	const { sqlite, db } = createDb()
	clearCachedPackageAppCustomHostnames(db)
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'acme')`).run()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, deleted_at
			) VALUES ('pkg-1', 'org-1', '@acme/old', 'old', NULL)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'row-1', 'apps.example.com', 'app', 'pkg-1', NULL,
				'cf-1', 'zone', 'active', 'active', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()
	const first = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	expect(first?.kodyId).toBe('old')
	sqlite
		.prepare(
			`UPDATE saved_packages SET name = '@acme/new', kody_id = 'new' WHERE id = 'pkg-1'`,
		)
		.run()
	clearCachedPackageAppCustomHostnames(db)
	const refreshed = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	expect(refreshed?.kodyId).toBe('new')
})

test('a later lookup does its own read when the lookup it would share fails with an ended request', async () => {
	const base = createDb()
	await insertActiveOrgHostname(base.db)
	const { db, release } = stallNextRead(base.db)
	clearCachedPackageAppCustomHostnames(db)

	const ended = lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	const later = lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	release(
		new Error(
			'This promise was created by a request that has since ended, so it can never settle.',
		),
	)

	await expect(ended).rejects.toThrow('request that has since ended')
	expect((await later)?.hostname).toBe('apps.example.com')
})

test('a later lookup does its own read when the lookup it would share never settles', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	const base = createDb()
	await insertActiveOrgHostname(base.db)
	const { db } = stallNextRead(base.db)
	clearCachedPackageAppCustomHostnames(db)

	void lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	const later = lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	await vi.advanceTimersByTimeAsync(5_000)

	expect((await later)?.verified).toBe(true)
})
