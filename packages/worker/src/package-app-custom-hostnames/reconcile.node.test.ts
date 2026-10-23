import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	packageAppCustomHostnameGracePeriodMs,
	reconcilePackageAppCustomHostnames,
} from './reconcile.ts'

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
	return createD1FromSqlite(sqlite)
}

async function insertHostname(
	db: D1Database,
	input: {
		id: string
		hostname: string
		cfId: string
		status?: string
		sslStatus?: string
		verifiedAt?: string | null
		dnsMissingSince?: string | null
	},
) {
	const created = '2026-10-10T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, verified_at, dns_missing_since,
				created_at, updated_at
			) VALUES (
				?, ?, 'org', NULL, 'org-1',
				?, 'zone1',
				?, ?, ?, ?,
				?, ?
			)`,
		)
		.bind(
			input.id,
			input.hostname,
			input.cfId,
			input.status ?? 'active',
			input.sslStatus ?? 'active',
			input.verifiedAt ?? created,
			input.dnsMissingSince ?? null,
			created,
			created,
		)
		.run()
}

function activeFetcher(statusByCfId: Record<string, string> = {}): Fetcher {
	return {
		fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const cfId = new URL(request.url).pathname.split('/').at(-1) ?? 'unknown'
			if (request.method === 'DELETE') {
				return new Response(
					JSON.stringify({
						success: true,
						result: { id: cfId, hostname: '', status: 'deleted' },
					}),
					{ status: 200 },
				)
			}
			return new Response(
				JSON.stringify({
					success: true,
					result: {
						id: cfId,
						hostname: `${cfId}.example.com`,
						status: statusByCfId[cfId] ?? 'active',
						ssl: { status: 'active' },
					},
				}),
				{ status: 200 },
			)
		}),
		connect() {
			throw new Error('connect is not used')
		},
	} as Fetcher
}

async function readCursor(db: D1Database) {
	return db
		.prepare(
			`SELECT after_id FROM package_app_custom_hostname_reconcile_cursor WHERE singleton = 1`,
		)
		.first<{ after_id: string }>()
}

test('reconcile removes hostnames after the dns_missing grace period', async () => {
	const db = createDb()
	const created = '2026-10-10T00:00:00.000Z'
	const missingSince = new Date(
		Date.parse('2026-10-13T12:00:00.000Z') -
			packageAppCustomHostnameGracePeriodMs -
			60_000,
	).toISOString()
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`).run()
	await insertHostname(db, {
		id: 'row-1',
		hostname: 'gone.example.com',
		cfId: 'cf-1',
		status: 'moved',
		sslStatus: 'deleted',
		verifiedAt: created,
		dnsMissingSince: missingSince,
	})

	const env = {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher: activeFetcher({ 'cf-1': 'moved' }),
	} as unknown as Env

	const result = await reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
	})
	expect(result.removed).toBe(1)
	const row = await db
		.prepare(`SELECT * FROM package_app_custom_hostnames WHERE id = 'row-1'`)
		.first()
	expect(row).toBeNull()
})

test('reconcile persists the scan cursor across budget-exhausted ticks', async () => {
	const db = createDb()
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`).run()
	await insertHostname(db, {
		id: 'row-a',
		hostname: 'a.example.com',
		cfId: 'cf-a',
	})
	await insertHostname(db, {
		id: 'row-b',
		hostname: 'b.example.com',
		cfId: 'cf-b',
	})
	await insertHostname(db, {
		id: 'row-c',
		hostname: 'c.example.com',
		cfId: 'cf-c',
	})

	const fetcher = activeFetcher()
	const env = {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher,
	} as unknown as Env

	let nowMs = 1_000
	const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)

	// First tick: allow the batch fetch, then expire before any row work so the
	// per-row deadline check persists an advanced cursor after row-a is skipped
	// once we let one row through.
	nowMs = 1_000
	const firstPromise = reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
		batchSize: 1,
		timeBudgetMs: 100,
	})
	// After entering the batch loop for row-a, jump past the deadline on the
	// next Date.now() check inside the per-row loop by advancing mid-flight
	// once the fetcher is invoked.
	const fetchMock = fetcher.fetch as ReturnType<typeof vi.fn>
	const originalFetch = fetchMock.getMockImplementation() as (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>
	fetchMock.mockImplementation(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			nowMs = 1_200
			return originalFetch(input, init)
		},
	)
	const first = await firstPromise
	expect(first.scanned).toBe(1)
	expect(first.budgetExhausted).toBe(true)
	expect((await readCursor(db))?.after_id).toBe('row-a')

	// Second tick resumes after row-a and finishes the remaining rows without
	// wrapping back over the already-scanned head.
	nowMs = 2_000
	fetchMock.mockImplementation(originalFetch)
	const second = await reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
		batchSize: 10,
		timeBudgetMs: 60_000,
	})
	expect(second.scanned).toBe(2)
	expect(second.budgetExhausted).toBe(false)
	expect((await readCursor(db))?.after_id).toBe('')

	nowSpy.mockRestore()
})

test('reconcile does not double-scan when the table size is an exact batch multiple', async () => {
	const db = createDb()
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`).run()
	for (const id of ['row-a', 'row-b']) {
		await insertHostname(db, {
			id,
			hostname: `${id}.example.com`,
			cfId: `cf-${id}`,
		})
	}

	const fetcher = activeFetcher()
	const env = {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher,
	} as unknown as Env

	const result = await reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
		batchSize: 2,
		timeBudgetMs: 60_000,
	})
	expect(result.scanned).toBe(2)
	expect(result.budgetExhausted).toBe(false)
	expect((await readCursor(db))?.after_id).toBe('')
	expect((fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
})

test('reconcile cursor compare-and-swap does not regress a newer cursor', async () => {
	const db = createDb()
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`).run()
	for (const id of ['row-a', 'row-b', 'row-c']) {
		await insertHostname(db, {
			id,
			hostname: `${id}.example.com`,
			cfId: `cf-${id}`,
		})
	}

	const fetcher = activeFetcher()
	const env = {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher,
	} as unknown as Env

	let nowMs = 1_000
	const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const fetchMock = fetcher.fetch as ReturnType<typeof vi.fn>
	const originalFetch = fetchMock.getMockImplementation() as (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>
	fetchMock.mockImplementation(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			// Simulate a concurrent reconcile that already advanced past us.
			await db
				.prepare(
					`UPDATE package_app_custom_hostname_reconcile_cursor
					 SET after_id = 'row-c', updated_at = ? WHERE singleton = 1`,
				)
				.bind(new Date().toISOString())
				.run()
			nowMs = 1_200
			return originalFetch(input, init)
		},
	)

	const result = await reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
		batchSize: 1,
		timeBudgetMs: 100,
	})
	expect(result.scanned).toBe(1)
	expect((await readCursor(db))?.after_id).toBe('row-c')
	nowSpy.mockRestore()
})

test('reconcile sets budgetExhausted when the outer loop hits the deadline', async () => {
	const db = createDb()
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`).run()
	for (const id of ['row-1', 'row-2', 'row-3']) {
		await insertHostname(db, {
			id,
			hostname: `${id}.example.com`,
			cfId: `cf-${id}`,
		})
	}

	const fetcher = activeFetcher()
	const env = {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher,
	} as unknown as Env

	// deadline = 5000 + 100. Process one full batch of size 1 under budget,
	// then the next while check sees now past the deadline without the
	// per-row path setting budgetExhausted.
	let nowMs = 5_000
	const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const fetchMock = fetcher.fetch as ReturnType<typeof vi.fn>
	fetchMock.mockImplementation(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const cfId = new URL(request.url).pathname.split('/').at(-1) ?? 'unknown'
			nowMs = 5_150
			return new Response(
				JSON.stringify({
					success: true,
					result: {
						id: cfId,
						hostname: `${cfId}.example.com`,
						status: 'active',
						ssl: { status: 'active' },
					},
				}),
				{ status: 200 },
			)
		},
	)

	const result = await reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
		batchSize: 1,
		timeBudgetMs: 100,
	})
	expect(result.scanned).toBe(1)
	expect(result.budgetExhausted).toBe(true)
	expect((await readCursor(db))?.after_id).toBe('row-1')
	nowSpy.mockRestore()
})
