import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as StatusNotice from './status-notice.ts'

const notifyOwnersOfCustomHostnameStatus = vi.fn<
	typeof StatusNotice.notifyOwnersOfCustomHostnameStatus
>(async () => ({ recipients: 1, delivered: 1 }))

vi.mock('./status-notice.ts', () => ({
	notifyOwnersOfCustomHostnameStatus: (
		...args: Parameters<typeof StatusNotice.notifyOwnersOfCustomHostnameStatus>
	) => notifyOwnersOfCustomHostnameStatus(...args),
}))

const { reconcilePackageAppCustomHostnames } = await import('./reconcile.ts')

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../migrations',
)
const migrationSql = [
	'0133-package-app-custom-hostnames.sql',
	'0135-package-app-custom-hostname-verification.sql',
	'0139-package-app-custom-hostname-reconcile-cursor.sql',
	'0175-package-app-custom-hostname-auto-check.sql',
]
	.map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
	.join('\n')

const now = new Date('2026-10-20T12:00:00.000Z')
const hour = 60 * 60 * 1000

function hoursAgo(hours: number) {
	return new Date(now.getTime() - hours * hour).toISOString()
}

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (id TEXT PRIMARY KEY, slug TEXT, deleted_at TEXT);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			deleted_at TEXT
		);
	`)
	sqlite.exec(migrationSql)
	sqlite.exec(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`)
	return createD1FromSqlite(sqlite)
}

async function insertPending(
	db: D1Database,
	input: {
		id: string
		createdAt: string
		updatedAt?: string
		needsAttentionAt?: string | null
	},
) {
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, verified_at,
				needs_attention_at, created_at, updated_at
			) VALUES (?, ?, 'org', NULL, 'org-1', ?, 'zone1', 'pending', 'pending_validation', NULL, ?, ?, ?)`,
		)
		.bind(
			input.id,
			`${input.id}.example.com`,
			`cf-${input.id}`,
			input.needsAttentionAt ?? null,
			input.createdAt,
			input.updatedAt ?? input.createdAt,
		)
		.run()
}

function cloudflareFetcher(input: {
	status: string
	sslStatus: string
	verificationErrors?: Array<string>
}) {
	return {
		fetch: vi.fn(async (request: RequestInfo | URL) => {
			const cfId = new URL(String(request)).pathname.split('/').at(-1) ?? ''
			return new Response(
				JSON.stringify({
					success: true,
					result: {
						id: cfId,
						hostname: `${cfId}.example.com`,
						status: input.status,
						verification_errors: input.verificationErrors,
						ownership_verification: {
							type: 'txt',
							name: `_cf-custom-hostname.${cfId}.example.com`,
							value: 'owner-token',
						},
						ssl: { status: input.sslStatus },
					},
				}),
				{ status: 200 },
			)
		}),
	} as unknown as Fetcher
}

function envFor(db: D1Database, fetcher: Fetcher) {
	return {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher,
	} as unknown as Env
}

async function readRow(db: D1Database, id: string) {
	return db
		.prepare(
			`SELECT hostname_status, ssl_status, verified_at, needs_attention_at,
			        verification_errors_json, ownership_verification_json
			 FROM package_app_custom_hostnames WHERE id = ?`,
		)
		.bind(id)
		.first<{
			hostname_status: string
			ssl_status: string
			verified_at: string | null
			needs_attention_at: string | null
			verification_errors_json: string | null
			ownership_verification_json: string | null
		}>()
}

test('a pending hostname that goes active is recorded once and the owners are emailed once', async () => {
	notifyOwnersOfCustomHostnameStatus.mockClear()
	const db = createDb()
	await insertPending(db, { id: 'fresh', createdAt: hoursAgo(0.1) })
	const fetcher = cloudflareFetcher({ status: 'active', sslStatus: 'active' })
	const first = await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now,
	})
	expect(first.activated).toBe(1)
	expect(await readRow(db, 'fresh')).toMatchObject({
		hostname_status: 'active',
		ssl_status: 'active',
		verified_at: now.toISOString(),
	})
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
	expect(notifyOwnersOfCustomHostnameStatus.mock.calls[0]?.[0]).toMatchObject({
		event: 'active',
		row: { id: 'fresh', hostname: 'fresh.example.com' },
	})

	await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now: new Date(now.getTime() + 5 * 60 * 1000),
	})
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
})

test('pending hostnames back off: every tick for the first hour, then less often', async () => {
	notifyOwnersOfCustomHostnameStatus.mockClear()
	const db = createDb()
	// Three hours in and checked 10 minutes ago: not due (15-minute interval).
	await insertPending(db, {
		id: 'waiting',
		createdAt: hoursAgo(3),
		updatedAt: hoursAgo(10 / 60),
	})
	// Twenty minutes in and checked 5 minutes ago: due (every tick).
	await insertPending(db, {
		id: 'young',
		createdAt: hoursAgo(20 / 60),
		updatedAt: hoursAgo(5 / 60),
	})
	const fetcher = cloudflareFetcher({
		status: 'pending',
		sslStatus: 'pending_validation',
		verificationErrors: ['custom hostname does not CNAME to this zone.'],
	})
	const result = await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now,
	})
	expect(result).toMatchObject({ scanned: 2, updated: 1, skipped: 1 })
	expect(fetcher.fetch).toHaveBeenCalledTimes(1)
	const young = await readRow(db, 'young')
	expect(JSON.parse(young?.verification_errors_json ?? '[]')).toEqual([
		'custom hostname does not CNAME to this zone.',
	])
	expect(young?.ownership_verification_json).toContain('owner-token')
	expect(notifyOwnersOfCustomHostnameStatus).not.toHaveBeenCalled()
})

test('after the 48 hour window Kody marks needs attention, emails once, and stops checking', async () => {
	notifyOwnersOfCustomHostnameStatus.mockClear()
	const db = createDb()
	await insertPending(db, {
		id: 'stalled',
		createdAt: hoursAgo(49),
		updatedAt: hoursAgo(2),
	})
	const fetcher = cloudflareFetcher({
		status: 'pending',
		sslStatus: 'pending_validation',
	})
	const first = await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now,
	})
	expect(first.needsAttention).toBe(1)
	expect((await readRow(db, 'stalled'))?.needs_attention_at).toBe(
		now.toISOString(),
	)
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
	expect(notifyOwnersOfCustomHostnameStatus.mock.calls[0]?.[0]).toMatchObject({
		event: 'needs_attention',
	})

	const second = await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now: new Date(now.getTime() + 2 * hour),
	})
	expect(second).toMatchObject({ skipped: 1, updated: 0 })
	expect(fetcher.fetch).toHaveBeenCalledTimes(1)
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
})

test('hostnames that were already stale long before the window ended get the status but no email', async () => {
	notifyOwnersOfCustomHostnameStatus.mockClear()
	const db = createDb()
	await insertPending(db, { id: 'ancient', createdAt: hoursAgo(24 * 10) })
	const fetcher = cloudflareFetcher({
		status: 'pending',
		sslStatus: 'pending_validation',
	})
	const result = await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now,
	})
	expect(result.needsAttention).toBe(1)
	expect((await readRow(db, 'ancient'))?.needs_attention_at).toBe(
		now.toISOString(),
	)
	expect(notifyOwnersOfCustomHostnameStatus).not.toHaveBeenCalled()
})

test('a terminal Cloudflare failure marks needs attention before the window ends and stops checking', async () => {
	notifyOwnersOfCustomHostnameStatus.mockClear()
	const db = createDb()
	await insertPending(db, { id: 'timedout', createdAt: hoursAgo(2) })
	const fetcher = cloudflareFetcher({
		status: 'pending',
		sslStatus: 'validation_timed_out',
	})
	const result = await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now,
	})
	expect(result.needsAttention).toBe(1)
	expect(await readRow(db, 'timedout')).toMatchObject({
		ssl_status: 'validation_timed_out',
		needs_attention_at: now.toISOString(),
	})
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
	expect(notifyOwnersOfCustomHostnameStatus.mock.calls[0]?.[0]).toMatchObject({
		event: 'needs_attention',
		row: { id: 'timedout', sslStatus: 'validation_timed_out' },
	})

	await reconcilePackageAppCustomHostnames({
		env: envFor(db, fetcher),
		now: new Date(now.getTime() + 2 * hour),
	})
	expect(fetcher.fetch).toHaveBeenCalledTimes(1)
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
})

test('a failed row write does not leave an activation claim behind', async () => {
	notifyOwnersOfCustomHostnameStatus.mockClear()
	const db = createDb()
	await insertPending(db, { id: 'flaky', createdAt: hoursAgo(0.1) })
	const fetcher = cloudflareFetcher({ status: 'active', sslStatus: 'active' })
	let failBatch = true
	const flakyDb = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === 'batch') {
				return async (statements: Array<D1PreparedStatement>) => {
					if (failBatch) {
						failBatch = false
						throw new Error('D1 write failed')
					}
					return target.batch(statements)
				}
			}
			const value = Reflect.get(target, prop, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	consoleError.mockImplementation(() => {})
	const first = await reconcilePackageAppCustomHostnames({
		env: envFor(flakyDb, fetcher),
		now,
	})
	expect(first.errors).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'package_app_custom_hostnames reconcile failed:',
		'flaky.example.com',
		'D1 write failed',
	)
	expect((await readRow(db, 'flaky'))?.verified_at).toBeNull()
	expect(notifyOwnersOfCustomHostnameStatus).not.toHaveBeenCalled()

	const second = await reconcilePackageAppCustomHostnames({
		env: envFor(flakyDb, fetcher),
		now: new Date(now.getTime() + 5 * 60 * 1000),
	})
	expect(second.activated).toBe(1)
	expect(notifyOwnersOfCustomHostnameStatus).toHaveBeenCalledTimes(1)
})
