import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { StatusStore, type StatusWorkerEnv } from './status-store.ts'

function createStore() {
	const db = new DatabaseSync(':memory:')
	const ctx = {
		storage: {
			sql: {
				exec(query: string, ...bindings: Array<SQLInputValue>) {
					const rows = db.prepare(query).all(...bindings)
					return { toArray: () => rows }
				},
			},
			transactionSync<T>(fn: () => T): T {
				db.exec('BEGIN')
				try {
					const result = fn()
					db.exec('COMMIT')
					return result
				} catch (error) {
					db.exec('ROLLBACK')
					throw error
				}
			},
		},
		blockConcurrencyWhile(fn: () => Promise<void>) {
			return fn()
		},
		waitUntil() {},
	}
	const env = {
		PRIMARY_ORIGIN: 'https://kody.codes',
		PACKAGE_APP_ORIGIN: 'https://kody.run',
		STATUS_PAGE_URL: 'https://status.kody.codes',
		ALERT_EMAIL_TO: 'ops@example.com',
		ALERT_EMAIL_FROM: 'status@example.com',
	} as StatusWorkerEnv
	const store = new StatusStore(ctx as unknown as DurableObjectState, env)
	return { db, store }
}

const now = Date.parse('2026-10-12T15:00:00.000Z')

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(now)
	vi.spyOn(console, 'info').mockImplementation(() => {})
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function insertIncident(
	db: DatabaseSync,
	component: string,
	startedAt: string,
	resolvedAt: string | null,
) {
	const result = db
		.prepare(
			`INSERT INTO incidents (component, started_at, resolved_at, detail)
			VALUES (?, ?, ?, 'error')`,
		)
		.run(
			component,
			Date.parse(startedAt),
			resolvedAt === null ? null : Date.parse(resolvedAt),
		)
	return Number(result.lastInsertRowid)
}

function insertFailedSample(db: DatabaseSync, component: string, at: string) {
	db.prepare(
		`INSERT INTO samples (component, checked_at, ok, latency_ms, detail)
		VALUES (?, ?, 0, NULL, 'error')`,
	).run(component, Date.parse(at))
}

function dailyFailed(db: DatabaseSync, component: string, day: string) {
	return db
		.prepare(`SELECT failed FROM daily_stats WHERE component = ? AND day = ?`)
		.get(component, day)?.failed
}

test('deleteIncident removes a resolved incident and clears its day', async () => {
	const { db, store } = createStore()
	const deletedId = insertIncident(
		db,
		'app_db',
		'2026-10-12T13:21:14.333Z',
		'2026-10-12T13:22:11.371Z',
	)
	insertFailedSample(db, 'app_db', '2026-10-12T13:20:14.000Z')
	insertFailedSample(db, 'app_db', '2026-10-12T13:21:14.333Z')
	db.prepare(
		`INSERT INTO daily_stats (component, day, total, failed)
		VALUES ('app_db', '2026-10-12', 1020, 1), ('kv', '2026-10-12', 1020, 3)`,
	).run()
	const kvId = insertIncident(
		db,
		'kv',
		'2026-10-12T10:00:00.000Z',
		'2026-10-12T10:03:00.000Z',
	)

	const result = await store.deleteIncident(deletedId)

	expect(result).toMatchObject({
		ok: true,
		incident: {
			id: deletedId,
			component: 'app_db',
			resolvedAt: '2026-10-12T13:22:11.371Z',
		},
	})
	expect(db.prepare(`SELECT id FROM incidents ORDER BY id`).all()).toEqual([
		{ id: kvId },
	])
	expect(dailyFailed(db, 'app_db', '2026-10-12')).toBe(0)
	expect(dailyFailed(db, 'kv', '2026-10-12')).toBe(3)
	expect(await store.deleteIncident(deletedId)).toEqual({
		ok: false,
		error: 'not-found',
	})
})

test('deleteIncident keeps another incident failures on a shared day', async () => {
	const { db, store } = createStore()
	insertIncident(
		db,
		'app_db',
		'2026-10-12T09:00:00.000Z',
		'2026-10-12T09:04:00.000Z',
	)
	const deletedId = insertIncident(
		db,
		'app_db',
		'2026-10-12T13:21:00.000Z',
		'2026-10-12T13:23:00.000Z',
	)
	insertFailedSample(db, 'app_db', '2026-10-12T13:21:00.000Z')
	insertFailedSample(db, 'app_db', '2026-10-12T13:22:00.000Z')
	insertFailedSample(db, 'app_db', '2026-10-12T13:23:00.000Z')
	db.prepare(
		`INSERT INTO daily_stats (component, day, total, failed)
		VALUES ('app_db', '2026-10-12', 1020, 6)`,
	).run()

	expect((await store.deleteIncident(deletedId)).ok).toBe(true)
	expect(dailyFailed(db, 'app_db', '2026-10-12')).toBe(4)
})

test('deleteIncident estimates failures from minutes once samples are pruned', async () => {
	const { db, store } = createStore()
	insertIncident(
		db,
		'app_db',
		'2026-10-10T09:00:00.000Z',
		'2026-10-10T09:04:00.000Z',
	)
	const deletedId = insertIncident(
		db,
		'app_db',
		'2026-10-10T13:21:00.000Z',
		'2026-10-10T13:23:00.000Z',
	)
	db.prepare(
		`INSERT INTO daily_stats (component, day, total, failed)
		VALUES ('app_db', '2026-10-10', 1440, 6)`,
	).run()

	expect((await store.deleteIncident(deletedId)).ok).toBe(true)
	expect(dailyFailed(db, 'app_db', '2026-10-10')).toBe(4)
})

test('deleteIncident refuses open and unknown incidents', async () => {
	const { db, store } = createStore()
	const openId = insertIncident(db, 'app_db', '2026-10-12T14:58:00.000Z', null)
	db.prepare(
		`INSERT INTO daily_stats (component, day, total, failed)
		VALUES ('app_db', '2026-10-12', 1020, 2)`,
	).run()

	expect(await store.deleteIncident(openId)).toEqual({
		ok: false,
		error: 'not-resolved',
	})
	expect(await store.deleteIncident(999)).toEqual({
		ok: false,
		error: 'not-found',
	})
	expect(db.prepare(`SELECT id FROM incidents`).all()).toEqual([{ id: openId }])
	expect(dailyFailed(db, 'app_db', '2026-10-12')).toBe(2)
})

test('origin HTTP 503 does not open storage incidents', async () => {
	const { db, store } = createStore()
	const fetchImpl = (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url.startsWith('https://kody.codes/health/components')) {
			return new Response(null, { status: 503 })
		}
		if (url.startsWith('https://kody.codes/health')) {
			return new Response(null, { status: 503 })
		}
		if (url.startsWith('https://kody.codes/mcp')) {
			return new Response(null, { status: 503 })
		}
		if (url.startsWith('https://kody.run/__runtime/health')) {
			return new Response(
				JSON.stringify({
					status: 'ok',
					commitSha: 'abc123def4567890abcdef1234567890abcdef12',
				}),
			)
		}
		if (url.startsWith('https://kody-jobs.internal/health/components')) {
			return new Response(
				JSON.stringify({
					ok: true,
					components: [{ id: 'jobs_db', ok: true, latencyMs: 1 }],
				}),
			)
		}
		if (url.startsWith('https://kody-jobs.internal/health')) {
			return new Response(
				JSON.stringify({
					ok: true,
					commit: 'abc123def4567890abcdef1234567890abcdef12',
				}),
			)
		}
		return new Response(null, { status: 503 })
	}) as typeof fetch
	vi.stubGlobal('fetch', fetchImpl)

	for (let tick = 0; tick < 3; tick += 1) {
		await store.runProbes()
	}

	expect(
		db.prepare(`SELECT component FROM incidents ORDER BY component`).all(),
	).toEqual([{ component: 'app' }, { component: 'mcp' }])
	expect(
		db
			.prepare(`SELECT COUNT(*) AS n FROM samples WHERE component = 'app_db'`)
			.get(),
	).toEqual({ n: 0 })
})
