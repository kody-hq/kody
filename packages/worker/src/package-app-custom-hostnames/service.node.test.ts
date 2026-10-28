import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import * as packageRepo from '#worker/package-registry/repo.ts'
import { packageAppCustomHostnameMaxPerOrg } from './limits.ts'
import {
	addPackageAppCustomHostname,
	deletePackageAppCustomHostname,
	listPackageAppCustomHostnames,
	PackageAppCustomHostnameError,
	syncPackageAppCustomHostname,
} from './service.ts'

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../migrations',
)
const migrationSql = [
	'0133-package-app-custom-hostnames.sql',
	'0135-package-app-custom-hostname-verification.sql',
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
			deleted_at TEXT,
			plan TEXT NOT NULL DEFAULT 'free',
			stripe_plan TEXT
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			deleted_at TEXT,
			is_internet_visible INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE feature_flags (
			key TEXT PRIMARY KEY,
			enabled INTEGER NOT NULL,
			rollout_percent INTEGER,
			audience TEXT NOT NULL DEFAULT 'everyone'
		);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT,
			personal_org_id TEXT,
			experiments_opt_in INTEGER NOT NULL DEFAULT 0,
			deleted_at TEXT
		);
		CREATE TABLE feature_flag_user_overrides (
			flag_key TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			enabled INTEGER NOT NULL,
			PRIMARY KEY (flag_key, user_id)
		);
		CREATE TABLE feature_flag_org_overrides (
			flag_key TEXT NOT NULL,
			org_id TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			PRIMARY KEY (flag_key, org_id)
		);
		CREATE TABLE org_memberships (
			org_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			deleted_at TEXT,
			PRIMARY KEY (org_id, user_id)
		);
		INSERT INTO users (id, stable_user_id, experiments_opt_in) VALUES (1, 'person-1', 1);
	`)
	sqlite.exec(migrationSql)
	return createD1FromSqlite(sqlite)
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		PACKAGE_APP_ZONE_ID: 'zonetest123',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
	} as unknown as Env
}

function cfHostnameResponse(
	overrides: {
		id?: string
		hostname?: string
		status?: string
		sslStatus?: string
		method?: string
	} = {},
) {
	return new Response(
		JSON.stringify({
			success: true,
			result: {
				id: overrides.id ?? 'cf-1',
				hostname: overrides.hostname ?? 'team.example.com',
				status: overrides.status ?? 'pending',
				ownership_verification: {
					type: 'txt',
					name: '_cf-custom-hostname.team.example.com',
					value: 'ownership-token',
				},
				ssl: {
					status: overrides.sslStatus ?? 'pending_validation',
					validation_records: [
						{
							txt_name: '_acme-challenge.team.example.com',
							txt_value: 'ssl-token',
						},
					],
				},
			},
		}),
		{ status: 200 },
	)
}

test('add rejects app-level hostnames for non-internet-visible packages', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	vi.spyOn(packageRepo, 'getSavedPackageById').mockResolvedValue({
		id: 'pkg-1',
		userId: 'org-1',
		name: '@acme/demo',
		isInternetVisible: false,
	} as Awaited<ReturnType<typeof packageRepo.getSavedPackageById>>)

	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
	} as unknown as Fetcher

	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			actingUserId: 1,
			createdByUserId: 'person-1',
			bindingKind: 'app',
			hostname: 'app.example.com',
			packageId: 'pkg-1',
		}),
	).rejects.toThrow(PackageAppCustomHostnameError)
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('add rejects hostnames under Kody-owned domains before calling Cloudflare', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
	} as unknown as Fetcher
	const env = {
		...createEnv(db),
		APP_BASE_URL: 'https://kody.codes',
		APP_LEGACY_HOSTS: 'legacy-kody.example',
		fetcher,
	} as unknown as Env
	for (const hostname of [
		'docs.kody.codes',
		'KODY.CODES',
		'apps.kody.run',
		'old.legacy-kody.example',
		'demo.workers.dev',
	]) {
		await expect(
			addPackageAppCustomHostname({
				env,
				orgId: 'org-1',
				actingUserId: 1,
				createdByUserId: 'person-1',
				bindingKind: 'org',
				hostname,
			}),
		).rejects.toThrow(/cannot be a custom domain.*kody\.codes, kody\.run/)
	}
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('add rejects free-plan orgs before calling Cloudflare', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'free')`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
	} as unknown as Fetcher

	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			actingUserId: 1,
			createdByUserId: 'person-1',
			bindingKind: 'org',
			hostname: 'team.example.com',
		}),
	).rejects.toThrow(/paid organization plan/)
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('add rejects when the org is at the abuse hostname cap', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	for (let i = 0; i < packageAppCustomHostnameMaxPerOrg; i += 1) {
		await db
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id,
					cloudflare_hostname_id, cloudflare_zone_id,
					hostname_status, ssl_status, created_by_user_id,
					created_at, updated_at
				) VALUES (?, ?, 'org', NULL, 'org-1', ?, 'zonetest123', 'pending', 'pending', 'person-1', ?, ?)`,
			)
			.bind(
				`row-${i}`,
				`host-${i}.example.com`,
				`cf-${i}`,
				'2026-10-13T00:00:00.000Z',
				'2026-10-13T00:00:00.000Z',
			)
			.run()
	}
	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
	} as unknown as Fetcher
	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			actingUserId: 1,
			createdByUserId: 'person-1',
			bindingKind: 'org',
			hostname: 'overflow.example.com',
		}),
	).rejects.toThrow(/abuse limit/)
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('list and delete still reach app hostnames after the package is soft-deleted', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, is_internet_visible, deleted_at
			) VALUES ('pkg-1', 'org-1', '@acme/demo', 'demo', 1, '2026-10-13T00:00:00.000Z')`,
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
				'row-orphaned', 'orphaned.example.com', 'app', 'pkg-1', NULL,
				'cf-orphaned', 'zonetest123', 'active', 'active', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()
	const fetcher = {
		fetch: vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === 'DELETE') {
				return cfHostnameResponse({ status: 'deleted' })
			}
			return cfHostnameResponse()
		}),
	} as unknown as Fetcher
	const listed = await listPackageAppCustomHostnames({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
	})
	expect(listed.hostnames.map((row) => row.hostname)).toEqual([
		'orphaned.example.com',
	])
	await deletePackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		hostname: 'orphaned.example.com',
	})
	expect(
		await listPackageAppCustomHostnames({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			actingUserId: 1,
		}),
	).toEqual({ hostnames: [] })
})

test('abuse cap still counts app hostnames after the package is soft-deleted', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, is_internet_visible, deleted_at
			) VALUES ('pkg-1', 'org-1', '@acme/demo', 'demo', 1, '2026-10-13T00:00:00.000Z')`,
		)
		.run()
	for (let i = 0; i < packageAppCustomHostnameMaxPerOrg; i += 1) {
		await db
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id,
					cloudflare_hostname_id, cloudflare_zone_id,
					hostname_status, ssl_status, created_by_user_id,
					created_at, updated_at
				) VALUES (?, ?, 'app', 'pkg-1', NULL, ?, 'zonetest123', 'pending', 'pending', 'person-1', ?, ?)`,
			)
			.bind(
				`row-${i}`,
				`host-${i}.example.com`,
				`cf-${i}`,
				'2026-10-13T00:00:00.000Z',
				'2026-10-13T00:00:00.000Z',
			)
			.run()
	}
	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
	} as unknown as Fetcher
	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			actingUserId: 1,
			createdByUserId: 'person-1',
			bindingKind: 'org',
			hostname: 'overflow.example.com',
		}),
	).rejects.toThrow(/abuse limit/)
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('add stores app binding against the migrated schema with check_window_started_at', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, is_internet_visible, deleted_at
			) VALUES ('pkg-1', 'org-1', '@acme/demo', 'demo', 1, NULL)`,
		)
		.run()
	vi.spyOn(packageRepo, 'getSavedPackageById').mockResolvedValue({
		id: 'pkg-1',
		userId: 'org-1',
		name: '@acme/demo',
		isInternetVisible: true,
	} as Awaited<ReturnType<typeof packageRepo.getSavedPackageById>>)

	const fetcher = {
		fetch: vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === 'DELETE') {
				return cfHostnameResponse({
					id: 'cf-app',
					hostname: 'app.example.com',
					status: 'deleted',
				})
			}
			return cfHostnameResponse({
				id: 'cf-app',
				hostname: 'app.example.com',
			})
		}),
	} as unknown as Fetcher

	const added = await addPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		createdByUserId: 'person-1',
		bindingKind: 'app',
		hostname: 'app.example.com',
		packageId: 'pkg-1',
		sslMethod: 'txt',
	})
	expect(added.hostname.hostname).toBe('app.example.com')
	expect(added.hostname.binding_kind).toBe('app')
	expect(added.hostname.package_id).toBe('pkg-1')
	expect(added.hostname.org_id).toBeNull()
	expect(added.verification.ownership_verification?.value).toBe(
		'ownership-token',
	)

	const stored = await db
		.prepare(
			`SELECT binding_kind, package_id, org_id, cloudflare_hostname_id,
				check_window_started_at, needs_attention_at,
				verification_errors_json, created_at
			 FROM package_app_custom_hostnames WHERE hostname = ?`,
		)
		.bind('app.example.com')
		.first<{
			binding_kind: string
			package_id: string | null
			org_id: string | null
			cloudflare_hostname_id: string | null
			check_window_started_at: string | null
			needs_attention_at: string | null
			verification_errors_json: string | null
			created_at: string
		}>()
	expect(stored).toMatchObject({
		binding_kind: 'app',
		package_id: 'pkg-1',
		org_id: null,
		cloudflare_hostname_id: 'cf-app',
		needs_attention_at: null,
		verification_errors_json: null,
	})
	expect(stored?.check_window_started_at).toBe(stored?.created_at)
	expect(fetcher.fetch).toHaveBeenCalledTimes(1)
})

test('add stores org binding with verification records and list returns it', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === 'DELETE') {
				return cfHostnameResponse({ status: 'deleted' })
			}
			return cfHostnameResponse({
				id: 'cf-org',
				hostname: 'team.example.com',
			})
		}),
	} as unknown as Fetcher

	const added = await addPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		createdByUserId: 'person-1',
		bindingKind: 'org',
		hostname: 'team.example.com',
		sslMethod: 'txt',
	})
	expect(added.hostname.hostname).toBe('team.example.com')
	expect(added.dns.target).toBe('domains.kody.run')
	expect(added.verification.ownership_verification?.value).toBe(
		'ownership-token',
	)
	expect(added.verification.ssl_validation_records[0]?.value).toBe('ssl-token')
	expect(added.setup.records).toEqual([
		{
			type: 'CNAME',
			name: 'team.example.com',
			relative_name: 'team',
			value: 'domains.kody.run',
			proxy: 'dns_only',
			purpose: 'routing',
		},
		{
			type: 'TXT',
			name: '_cf-custom-hostname.team.example.com',
			relative_name: '_cf-custom-hostname.team',
			value: 'ownership-token',
			proxy: 'dns_only',
			purpose: 'ownership',
		},
		{
			type: 'TXT',
			name: '_acme-challenge.team.example.com',
			relative_name: '_acme-challenge.team',
			value: 'ssl-token',
			proxy: 'dns_only',
			purpose: 'certificate',
		},
	])
	expect(added.setup.steps.join('\n')).toMatch(/DNS only/)
	expect(added.setup.steps.join('\n')).toMatch(/re-checks pending hostnames/)
	expect(
		JSON.parse(
			String(
				(fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body,
			),
		),
	).toMatchObject({
		ssl: { method: 'txt', type: 'dv' },
	})

	const listed = await listPackageAppCustomHostnames({
		env: createEnv(db),
		orgId: 'org-1',
		actingUserId: 1,
	})
	expect(listed.hostnames).toHaveLength(1)
	expect(listed.hostnames[0]?.verification.ownership_verification?.value).toBe(
		'ownership-token',
	)
	expect(
		listed.hostnames[0]?.verification.ssl_validation_records[0]?.value,
	).toBe('ssl-token')

	const stored = await db
		.prepare(
			`SELECT check_window_started_at, created_at
			 FROM package_app_custom_hostnames WHERE hostname = ?`,
		)
		.bind('team.example.com')
		.first<{
			check_window_started_at: string | null
			created_at: string
		}>()
	expect(stored?.check_window_started_at).toBe(stored?.created_at)

	await deletePackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		hostname: 'team.example.com',
	})
	expect(
		await listPackageAppCustomHostnames({
			env: createEnv(db),
			orgId: 'org-1',
			actingUserId: 1,
		}),
	).toEqual({ hostnames: [] })
})

test('sync refreshes Cloudflare status and returns verification records', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
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
				'row-1', 'team.example.com', 'org', NULL, 'org-1',
				'cf-org', 'zonetest123', 'pending', 'pending', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(async () =>
			cfHostnameResponse({
				id: 'cf-org',
				hostname: 'team.example.com',
				status: 'active',
				sslStatus: 'active',
			}),
		),
	} as unknown as Fetcher

	const synced = await syncPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		id: 'row-1',
		now: new Date('2026-10-13T12:00:00.000Z'),
	})
	expect(synced.hostname.hostname_status).toBe('active')
	expect(synced.hostname.ssl_status).toBe('active')
	expect(synced.hostname.verified_at).toBe('2026-10-13T12:00:00.000Z')
	expect(synced.hostname.status).toEqual({ state: 'active', reason: null })
	expect(synced.verification.ownership_verification?.name).toBe(
		'_cf-custom-hostname.team.example.com',
	)
	expect(synced.setup.records.map((record) => record.type)).toEqual([
		'CNAME',
		'TXT',
		'TXT',
	])
})

test('add compensates with Cloudflare delete when the local insert fails', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
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
				'existing', 'team.example.com', 'org', NULL, 'org-1',
				'cf-old', 'zonetest123', 'pending', 'pending', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()

	const methods: Array<string> = []
	const fetcher = {
		fetch: vi.fn(async (_url: string, init?: RequestInit) => {
			methods.push(init?.method ?? 'GET')
			if (init?.method === 'DELETE') {
				return cfHostnameResponse({ id: 'cf-new', status: 'deleted' })
			}
			return cfHostnameResponse({ id: 'cf-new', hostname: 'team.example.com' })
		}),
	} as unknown as Fetcher

	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			actingUserId: 1,
			createdByUserId: 'person-1',
			bindingKind: 'org',
			hostname: 'team.example.com',
		}),
	).rejects.toThrow(/could not be stored/)
	expect(methods).toEqual(['POST', 'DELETE'])
})

test('add allows manual paid plan even when stripe_plan is free', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'pro', NULL)`,
		)
		.run()
	const fetcher = {
		fetch: vi.fn(async () =>
			cfHostnameResponse({ id: 'cf-manual', hostname: 'manual.example.com' }),
		),
	} as unknown as Fetcher
	const added = await addPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		createdByUserId: 'person-1',
		bindingKind: 'org',
		hostname: 'manual.example.com',
	})
	expect(added.hostname.hostname).toBe('manual.example.com')
})

test('sync prefers id over a conflicting hostname body', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	for (const [id, hostname, cfId] of [
		['row-a', 'a.example.com', 'cf-a'],
		['row-b', 'b.example.com', 'cf-b'],
	] as const) {
		await db
			.prepare(
				`INSERT INTO package_app_custom_hostnames (
					id, hostname, binding_kind, package_id, org_id,
					cloudflare_hostname_id, cloudflare_zone_id,
					hostname_status, ssl_status, created_by_user_id,
					created_at, updated_at
				) VALUES (?, ?, 'org', NULL, 'org-1', ?, 'zonetest123', 'pending', 'pending', 'person-1',
					'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
			)
			.bind(id, hostname, cfId)
			.run()
	}

	await expect(
		syncPackageAppCustomHostname({
			env: createEnv(db),
			orgId: 'org-1',
			actingUserId: 1,
			id: 'row-a',
			hostname: 'b.example.com',
		}),
	).rejects.toThrow(/does not match/)
})

test('sync marks Cloudflare-missing hostnames deleted and starts grace', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, verified_at, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'row-1', 'team.example.com', 'org', NULL, 'org-1',
				'cf-gone', 'zonetest123', 'active', 'active', '2026-10-12T00:00:00.000Z',
				'person-1', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z'
			)`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'not found', code: 1436 }] },
				{ status: 404 },
			),
		),
	} as unknown as Fetcher

	const synced = await syncPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		id: 'row-1',
		now: new Date('2026-10-13T12:00:00.000Z'),
	})
	expect(synced.hostname.hostname_status).toBe('deleted')
	expect(synced.hostname.dns_missing_since).toBe('2026-10-13T12:00:00.000Z')
	expect(synced.verification.ownership_verification).toBeNull()
	expect(synced.setup.records).toEqual([])
	expect(synced.setup.steps.join('\n')).toMatch(/Delete this custom hostname/)
})

test('sync on a stalled pending hostname clears needs attention and restarts the check window', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, plan, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free', 'pro')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				needs_attention_at, created_at, updated_at
			) VALUES (
				'row-1', 'team.example.com', 'org', NULL, 'org-1',
				'cf-org', 'zonetest123', 'pending', 'pending', 'person-1',
				'2026-10-12T00:00:00.000Z',
				'2026-10-10T00:00:00.000Z', '2026-10-12T00:00:00.000Z'
			)`,
		)
		.run()
	const fetcher = {
		fetch: vi.fn(async () =>
			cfHostnameResponse({ id: 'cf-org', hostname: 'team.example.com' }),
		),
	} as unknown as Fetcher
	const synced = await syncPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		actingUserId: 1,
		id: 'row-1',
		now: new Date('2026-10-13T12:00:00.000Z'),
	})
	expect(synced.hostname.status.state).toBe('pending')
	expect(synced.hostname.needs_attention_at).toBeNull()
	const stored = await db
		.prepare(
			`SELECT check_window_started_at, needs_attention_at FROM package_app_custom_hostnames WHERE id = 'row-1'`,
		)
		.first<{
			check_window_started_at: string | null
			needs_attention_at: string | null
		}>()
	expect(stored).toEqual({
		check_window_started_at: '2026-10-13T12:00:00.000Z',
		needs_attention_at: null,
	})
})
