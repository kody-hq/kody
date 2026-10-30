import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { CredentialClientError } from '#worker/credentials/credential-client.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { PackageAppRunsAsUnavailableError } from './package-app-authority.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

const scheduled = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduled.push(promise)
	},
}))

const {
	buildPackageAppAuthorityFallbackReport,
	hashPackageAppVisitorId,
	PackageAppCapabilityNotDeclaredError,
	PackageAppCapabilityUnavailableError,
	packageAppAuthorityFallbackKindOf,
	packageAppAuthorityFallbackKindOfResult,
	schedulePackageAppAuthorityFallback,
	schedulePackageAppAuthorityRejection,
} = await import('./package-app-authority-fallback.ts')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function drain() {
	await Promise.all(scheduled.splice(0))
}

test('only authority failures fall back; any other failure throws as it always did', () => {
	expect(
		packageAppAuthorityFallbackKindOf(
			new PackageAppCapabilityNotDeclaredError('secretList'),
		),
	).toBe('capability_not_declared')
	expect(
		packageAppAuthorityFallbackKindOf(
			new PackageAppCapabilityUnavailableError('beta'),
		),
	).toBe('capability_unavailable')
	expect(
		packageAppAuthorityFallbackKindOf(
			new PackageAppRunsAsUnavailableError('person-unavailable'),
		),
	).toBe('runs_as_unavailable')
	expect(
		packageAppAuthorityFallbackKindOf(
			new AuthorizationError({
				code: 'missing_permission',
				permission: 'secret:read',
				orgId: null,
				resource: null,
				message: 'no',
			}),
		),
	).toBe('permission_denied')
	expect(
		packageAppAuthorityFallbackKindOf(
			new CredentialClientError({
				code: 'credential_not_found',
				message: 'missing',
				retryWith: [],
			}),
		),
	).toBe('credential_unavailable')
	expect(
		packageAppAuthorityFallbackKindOf(
			new CredentialClientError({
				code: 'invalid_request',
				message: 'bad args',
				retryWith: [],
			}),
		),
	).toBeNull()
	expect(
		packageAppAuthorityFallbackKindOf(new Error('upstream 500')),
	).toBeNull()
	expect(
		packageAppAuthorityFallbackKindOfResult({
			ok: false,
			error: { code: 'credential_unbound' },
		}),
	).toBe('credential_unavailable')
	expect(
		packageAppAuthorityFallbackKindOfResult({
			ok: false,
			error: { code: 'invalid_request' },
		}),
	).toBeNull()
	expect(packageAppAuthorityFallbackKindOfResult({ ok: true })).toBeNull()
})

test('the fallback fires a structured would-break log and a queryable count, with a hashed visitor and no names', async () => {
	const { sqlite, db } = createDb()
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const visitorId = 'user-visitor-secret-handle'
	const event = {
		ownerId: 'org-1',
		packageId: 'pkg-1',
		callName: 'secretList',
		kind: 'capability_not_declared' as const,
		visitorId,
	}
	for (let index = 0; index < 3; index++) {
		schedulePackageAppAuthorityFallback({
			env: { APP_DB: db },
			event,
			now: `2026-10-24T08:00:0${index}.000Z`,
			flushDelayMs: 0,
		})
	}
	schedulePackageAppAuthorityFallback({
		env: { APP_DB: db },
		event: {
			...event,
			callName: 'fetch',
			kind: 'credential_unavailable',
			visitorId: null,
		},
		now: '2026-10-24T08:00:05.000Z',
		flushDelayMs: 0,
	})
	await drain()

	expect(warn).toHaveBeenCalledTimes(4)
	const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])))
	expect(logged[0]).toEqual({
		event: 'package_app_authority_fallback',
		packageId: 'pkg-1',
		callName: 'secretList',
		kind: 'capability_not_declared',
		visitor: 'person',
	})
	expect(logged[3]).toMatchObject({
		visitor: 'anonymous',
		kind: 'credential_unavailable',
	})
	for (const call of warn.mock.calls) {
		expect(String(call[0])).not.toContain(visitorId)
	}
	warn.mockRestore()

	const rows = sqlite
		.prepare(
			`SELECT call_name, difference_kind, visitor_hash, observations
			 FROM package_app_authority_fallbacks ORDER BY call_name`,
		)
		.all() as Array<Record<string, unknown>>
	expect(rows).toEqual([
		{
			call_name: 'fetch',
			difference_kind: 'credential_unavailable',
			visitor_hash: 'anonymous',
			observations: 1,
		},
		{
			call_name: 'secretList',
			difference_kind: 'capability_not_declared',
			visitor_hash: await hashPackageAppVisitorId(visitorId),
			observations: 3,
		},
	])
	expect(JSON.stringify(rows)).not.toContain(visitorId)

	const report = await buildPackageAppAuthorityFallbackReport({
		db,
		since: '2026-10-24',
	})
	expect(report.totals).toEqual({
		apps: 1,
		owners: 1,
		visitors: 2,
		observations: 4,
	})
	expect(report.packages).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			observations: 4,
			calls: [
				{
					callName: 'secretList',
					kind: 'capability_not_declared',
					observations: 3,
				},
				{ callName: 'fetch', kind: 'credential_unavailable', observations: 1 },
			],
		}),
	])
	expect(
		(
			await buildPackageAppAuthorityFallbackReport({
				db,
				since: '2026-10-25',
			})
		).totals.observations,
	).toBe(0)
})

test('hard rejections land in their own log, keyed like fallbacks, and the report reads both', async () => {
	const { sqlite, db } = createDb()
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const visitorId = 'user-visitor-secret-handle'
	const event = {
		ownerId: 'org-1',
		packageId: 'pkg-1',
		callName: 'secretList',
		kind: 'capability_not_declared' as const,
		visitorId,
	}
	// Same key as a fallback: the two logs must not coalesce into each other.
	schedulePackageAppAuthorityFallback({
		env: { APP_DB: db },
		event,
		now: '2026-10-24T08:00:00.000Z',
		flushDelayMs: 0,
	})
	for (let index = 0; index < 2; index++) {
		schedulePackageAppAuthorityRejection({
			env: { APP_DB: db },
			event,
			now: `2026-10-24T08:00:0${index + 1}.000Z`,
			flushDelayMs: 0,
		})
	}
	schedulePackageAppAuthorityRejection({
		env: { APP_DB: db },
		event: {
			...event,
			packageId: 'pkg-2',
			callName: 'credential:credentialClientOpen',
			visitorId: null,
		},
		now: '2026-10-24T08:00:05.000Z',
		flushDelayMs: 0,
	})
	await drain()

	const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])))
	expect(logged.map((line) => line.event)).toEqual([
		'package_app_authority_fallback',
		'package_app_authority_rejection',
		'package_app_authority_rejection',
		'package_app_authority_rejection',
	])
	for (const call of warn.mock.calls) {
		expect(String(call[0])).not.toContain(visitorId)
	}
	warn.mockRestore()

	const rejectionRows = sqlite
		.prepare(
			`SELECT package_id, call_name, difference_kind, visitor_hash, observations
			 FROM package_app_authority_rejections ORDER BY package_id`,
		)
		.all() as Array<Record<string, unknown>>
	expect(rejectionRows).toEqual([
		{
			package_id: 'pkg-1',
			call_name: 'secretList',
			difference_kind: 'capability_not_declared',
			visitor_hash: await hashPackageAppVisitorId(visitorId),
			observations: 2,
		},
		{
			package_id: 'pkg-2',
			call_name: 'credential:credentialClientOpen',
			difference_kind: 'capability_not_declared',
			visitor_hash: 'anonymous',
			observations: 1,
		},
	])
	expect(
		sqlite
			.prepare('SELECT observations FROM package_app_authority_fallbacks')
			.all(),
	).toEqual([{ observations: 1 }])

	const report = await buildPackageAppAuthorityFallbackReport({
		db,
		since: '2026-10-24',
	})
	expect(report.totals).toEqual({
		apps: 1,
		owners: 1,
		visitors: 1,
		observations: 1,
	})
	expect(report.hardRejections.totals).toEqual({
		apps: 2,
		owners: 1,
		visitors: 2,
		observations: 3,
	})
	expect(report.hardRejections.packagesTruncated).toBe(false)
	expect(report.hardRejections.packages).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			observations: 2,
			calls: [
				{
					callName: 'secretList',
					kind: 'capability_not_declared',
					observations: 2,
				},
			],
		}),
		expect.objectContaining({
			packageId: 'pkg-2',
			observations: 1,
		}),
	])
	const onlyPkg2 = await buildPackageAppAuthorityFallbackReport({
		db,
		since: '2026-10-24',
		packageId: 'pkg-2',
	})
	expect(onlyPkg2.totals.observations).toBe(0)
	expect(onlyPkg2.hardRejections.totals.observations).toBe(1)
})
