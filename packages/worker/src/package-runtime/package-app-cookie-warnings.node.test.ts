import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { loadPackageCookieWarningsForOwner } from '#worker/app/account-packages-data.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listPackageAppCookieWarnings,
	recordPackageAppCookieFindings,
	resetPackageAppCookieFindingWritesForTests,
} from './package-app-cookie-httponly.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const now = Date.parse('2026-10-22T12:00:00.000Z')

function createMigratedDb(options: { queries?: Array<string> } = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run('pkg-1', 'owner-1', 'demo', 'demo', '', 'source-1')
	return { sqlite, db: createD1FromSqlite(sqlite, options) }
}

test('upserts warning rows and throttles identical writes for one hour', async () => {
	resetPackageAppCookieFindingWritesForTests()
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	const finding = {
		cookieName: 'session=do-not-store-this-cookie-value',
		reason: 'added_httponly' as const,
	}
	await recordPackageAppCookieFindings({
		db,
		packageId: 'pkg-1',
		findings: [
			finding,
			{ cookieName: 'x'.repeat(140), reason: 'missing_httponly' },
		],
		hostname: 'app.example',
		pathname: '/entry',
		now,
	})
	const first = sqlite
		.prepare(
			'SELECT * FROM package_app_cookie_warnings WHERE package_id = ? AND cookie_name = ?',
		)
		.get('pkg-1', 'session') as Record<string, string>
	expect(first).toMatchObject({
		package_id: 'pkg-1',
		owner_user_id: 'owner-1',
		cookie_name: 'session',
		reason: 'added_httponly',
		first_seen_at: new Date(now).toISOString(),
		last_seen_at: new Date(now).toISOString(),
	})
	expect(JSON.stringify(first)).not.toContain('do-not-store')
	const truncatedName = sqlite
		.prepare(
			'SELECT cookie_name FROM package_app_cookie_warnings WHERE cookie_name LIKE ?',
		)
		.get('x%') as { cookie_name: string }
	expect(truncatedName.cookie_name).toHaveLength(128)

	await recordPackageAppCookieFindings({
		db,
		packageId: 'pkg-1',
		findings: [finding],
		hostname: 'app.example',
		pathname: '/entry',
		now: now + 30 * 60 * 1000,
	})
	const throttled = sqlite
		.prepare(
			'SELECT * FROM package_app_cookie_warnings WHERE package_id = ? AND cookie_name = ?',
		)
		.get('pkg-1', 'session') as Record<string, string>
	expect(throttled.last_seen_at).toBe(new Date(now).toISOString())

	const afterHour = now + 60 * 60 * 1000 + 1
	await recordPackageAppCookieFindings({
		db,
		packageId: 'pkg-1',
		findings: [finding],
		hostname: 'app.example',
		pathname: '/entry',
		now: afterHour,
	})
	await recordPackageAppCookieFindings({
		db,
		packageId: 'pkg-1',
		findings: [{ cookieName: 'session', reason: 'missing_httponly' }],
		hostname: 'app.example',
		pathname: '/entry',
		now: afterHour + 1,
	})
	const updated = sqlite
		.prepare(
			'SELECT * FROM package_app_cookie_warnings WHERE package_id = ? AND cookie_name = ?',
		)
		.get('pkg-1', 'session') as Record<string, string>
	expect(updated).toMatchObject({
		first_seen_at: new Date(now).toISOString(),
		last_seen_at: new Date(afterHour + 1).toISOString(),
		reason: 'missing_httponly',
	})
	resetPackageAppCookieFindingWritesForTests()
})

test('logs and writes only unthrottled findings', async () => {
	resetPackageAppCookieFindingWritesForTests()
	const queries: Array<string> = []
	const { db } = createMigratedDb({ queries })
	consoleWarn.mockImplementation(() => {})
	consoleWarn.mockClear()
	const finding = {
		cookieName: 'session=do-not-log-this-cookie-value',
		reason: 'added_httponly' as const,
	}

	try {
		await recordPackageAppCookieFindings({
			db,
			packageId: 'pkg-1',
			findings: [finding],
			hostname: 'app.example',
			pathname: '/entry',
			now,
		})
		await recordPackageAppCookieFindings({
			db,
			packageId: 'pkg-1',
			findings: [finding],
			hostname: 'app.example',
			pathname: '/entry',
			now: now + 30 * 60 * 1000,
		})

		expect(consoleWarn).toHaveBeenCalledTimes(1)
		expect(consoleWarn).toHaveBeenCalledWith('package-app-cookie-httponly', {
			hostname: 'app.example',
			pathname: '/entry',
			packageId: 'pkg-1',
			findings: [{ cookieName: 'session', reason: 'added_httponly' }],
		})
		expect(consoleWarn.mock.calls.flat().join(' ')).not.toContain(
			'do-not-log-this-cookie-value',
		)
		expect(
			queries.filter((query) =>
				query.startsWith('INSERT INTO package_app_cookie_warnings'),
			),
		).toHaveLength(1)
	} finally {
		resetPackageAppCookieFindingWritesForTests()
	}
})

test('owner warning reads are recent, ordered, capped, and omitted for non-owners', async () => {
	const { sqlite, db } = createMigratedDb()
	const insert = sqlite.prepare(
		`INSERT INTO package_app_cookie_warnings (
			package_id, owner_user_id, cookie_name, reason, first_seen_at, last_seen_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
	)
	for (let index = 0; index < 55; index += 1) {
		const seenAt = new Date(now - index * 1000).toISOString()
		insert.run(
			'pkg-1',
			'owner-1',
			`cookie-${String(index).padStart(2, '0')}`,
			'missing_httponly',
			seenAt,
			seenAt,
		)
	}
	const staleAt = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString()
	insert.run('pkg-1', 'owner-1', 'stale', 'missing_httponly', staleAt, staleAt)
	const env = { APP_DB: db } as unknown as Env

	expect(
		await loadPackageCookieWarningsForOwner({
			env,
			packageId: 'pkg-1',
			now,
		}),
	).toBeUndefined()
	const warnings = await loadPackageCookieWarningsForOwner({
		env,
		packageId: 'pkg-1',
		ownerUsername: 'alice',
		now,
	})
	expect(warnings).toHaveLength(50)
	expect(warnings?.[0]).toMatchObject({
		cookieName: 'cookie-00',
		reason: 'missing_httponly',
		lastSeenAt: new Date(now).toISOString(),
	})
	expect(warnings?.at(-1)?.cookieName).toBe('cookie-49')
	expect(warnings?.some(({ cookieName }) => cookieName === 'stale')).toBe(false)
	expect(
		await listPackageAppCookieWarnings({ db, packageId: 'pkg-1', now }),
	).toEqual(warnings)
})
