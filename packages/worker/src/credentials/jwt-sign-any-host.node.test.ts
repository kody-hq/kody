import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	inferJwtSignSendToHost,
	isJwtSignAnyHostCallerGrandfathered,
	recordJwtSignAnyHostDestination,
} from './jwt-sign-any-host.ts'

const migration = readFileSync(
	new URL(
		'../../migrations/0238-jwt-sign-any-host-callers.sql',
		import.meta.url,
	),
	'utf8',
)
const caller = { ownerId: 'org-1', packageId: 'pkg-1' }

function createEnv(overrides: Record<string, string> = {}) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(migration)
	return {
		APP_DB: createD1FromSqlite(sqlite),
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'analytics-token',
		CLOUDFLARE_API_BASE_URL: 'https://cf.test',
		...overrides,
	} as unknown as Env
}

function stubAnalytics(calls: number) {
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		void init
		return Response.json({ data: [{ calls: String(calls) }] })
	})
	vi.stubGlobal('fetch', fetch)
	return fetch
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('a pair Analytics Engine saw making any-host calls is grandfathered and stored', async () => {
	const env = createEnv()
	const fetch = stubAnalytics(3)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller, now: 1_000 }),
	).resolves.toBe(true)
	const query = String(fetch.mock.calls[0]?.[1].body)
	expect(query).toContain('FROM kody_jwt_sign_any_host_events')
	expect(query).toContain(
		"blob1 = 'jwt_sign_any_host'\n\tAND blob2 = 'org-1'\n\tAND blob3 = 'pkg-1'",
	)

	fetch.mockClear()
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller, now: 1e12 }),
	).resolves.toBe(true)
	expect(fetch).not.toHaveBeenCalled()
})

test('an unseen pair is refused, and re-checked only after an hour', async () => {
	const env = createEnv()
	const fetch = stubAnalytics(0)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller, now: 0 }),
	).resolves.toBe(false)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller, now: 60_000 }),
	).resolves.toBe(false)
	expect(fetch).toHaveBeenCalledTimes(1)

	stubAnalytics(1)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller, now: 3_600_000 }),
	).resolves.toBe(true)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({
			env,
			caller: { ...caller, packageId: 'pkg-2' },
			now: 3_600_000,
		}),
	).resolves.toBe(true)
})

test('without Analytics Engine credentials nothing is grandfathered or stored', async () => {
	const env = createEnv({ CLOUDFLARE_API_TOKEN: '' })
	const fetch = stubAnalytics(5)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller }),
	).resolves.toBe(false)
	expect(fetch).not.toHaveBeenCalled()
	const row = await env.APP_DB.prepare(
		'SELECT COUNT(*) AS n FROM jwt_sign_any_host_callers',
	).first<{ n: number }>()
	expect(row?.n).toBe(0)
})

test('a failed Analytics Engine lookup throws instead of refusing', async () => {
	const env = createEnv()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('bad query', { status: 400 })),
	)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({ env, caller }),
	).rejects.toThrow(/Analytics Engine SQL query failed \(400\)/)
})

test('an id outside the expected shape is never put in the query', async () => {
	const env = createEnv()
	const fetch = stubAnalytics(1)
	await expect(
		isJwtSignAnyHostCallerGrandfathered({
			env,
			caller: { ownerId: "org' OR '1'='1", packageId: '' },
		}),
	).resolves.toBe(false)
	expect(fetch).not.toHaveBeenCalled()
})

test('send_to_host is inferred only when every fill went to one registrable domain', async () => {
	const env = createEnv()
	await expect(inferJwtSignSendToHost({ env, caller })).resolves.toBeNull()

	await recordJwtSignAnyHostDestination({
		env,
		caller,
		host: 'API.example.com',
	})
	await recordJwtSignAnyHostDestination({
		env,
		caller,
		host: 'api.example.com',
	})
	await recordJwtSignAnyHostDestination({
		env,
		caller,
		host: 'auth.example.com',
	})
	await expect(inferJwtSignSendToHost({ env, caller })).resolves.toBe(
		'api.example.com',
	)
	const counts = await env.APP_DB.prepare(
		'SELECT host, fill_count FROM jwt_sign_any_host_destinations ORDER BY host',
	).all<{ host: string; fill_count: number }>()
	expect(counts.results).toEqual([
		{ host: 'api.example.com', fill_count: 2 },
		{ host: 'auth.example.com', fill_count: 1 },
	])

	await recordJwtSignAnyHostDestination({
		env,
		caller,
		host: 'api.example.org',
	})
	await expect(inferJwtSignSendToHost({ env, caller })).resolves.toBeNull()
	await expect(
		inferJwtSignSendToHost({
			env,
			caller: { ...caller, packageId: '' },
		}),
	).resolves.toBeNull()
})
