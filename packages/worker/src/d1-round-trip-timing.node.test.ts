import { expect, test, vi } from 'vitest'
import {
	d1RoundTripServerTiming,
	timeD1RoundTrips,
} from './d1-round-trip-timing.ts'
import { getRequestContext, runWithRequestContext } from './request-context.ts'
import { formatServerTimingHeader } from './server-timing.ts'

function fakeD1(meta: Record<string, unknown> = {}) {
	const calls: Array<string> = []
	const result = (rows: Array<unknown>) => ({
		success: true,
		results: rows,
		meta: { duration: 2, ...meta },
	})
	function statement(sql: string, values: Array<unknown> = []) {
		const real = {
			sql,
			values,
			bind: (...next: Array<unknown>) => statement(sql, next),
			first: async () => (calls.push(`first ${sql}`), { id: values[0] }),
			all: async () => (calls.push(`all ${sql}`), result([{ id: 1 }])),
			run: async () => (calls.push(`run ${sql}`), result([])),
			raw: async () => (calls.push(`raw ${sql}`), [[1]]),
		}
		return real as unknown as D1PreparedStatement
	}
	const queries = {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: Array<D1PreparedStatement>) => {
			calls.push(
				`batch ${statements.map((entry) => (entry as unknown as { sql?: string }).sql).join('|')}`,
			)
			return statements.map(() => result([]))
		},
	}
	const db = {
		...queries,
		exec: async (sql: string) => (
			calls.push(`exec ${sql}`),
			{ count: 1, duration: 1 }
		),
		dump: async () => new ArrayBuffer(0),
		withSession: (constraint?: string) => {
			calls.push(`session ${constraint}`)
			return { ...queries, getBookmark: () => 'bookmark-1' }
		},
	} as unknown as D1Database
	return { db, calls }
}

function inRequest<Result>(run: () => Promise<Result>) {
	const request = new Request('https://kody.test/page')
	return runWithRequestContext(request, async () => ({
		result: await run(),
		totals: getRequestContext(request)?.d1,
	}))
}

test('forwards every call to the real database and returns its results', async () => {
	const { db, calls } = fakeD1()
	const timedDb = timeD1RoundTrips(db)
	const { result } = await inRequest(async () => ({
		first: await timedDb.prepare('one').bind(7).first(),
		all: await timedDb.prepare('two').all(),
		run: await timedDb.prepare('three').run(),
		raw: await timedDb.prepare('four').raw(),
		batch: await timedDb.batch([
			timedDb.prepare('five').bind(1),
			timedDb.prepare('six'),
		]),
		exec: await timedDb.exec('seven'),
		bookmark: timedDb.withSession('first-primary').getBookmark(),
		session: await timedDb.withSession('first-primary').prepare('eight').all(),
	}))
	expect(result.first).toEqual({ id: 7 })
	expect(result.all.results).toEqual([{ id: 1 }])
	expect(result.raw).toEqual([[1]])
	expect(result.batch).toHaveLength(2)
	expect(result.exec).toEqual({ count: 1, duration: 1 })
	expect(result.bookmark).toBe('bookmark-1')
	expect(calls).toEqual([
		'first one',
		'all two',
		'run three',
		'raw four',
		'batch five|six',
		'exec seven',
		'session first-primary',
		'session first-primary',
		'all eight',
	])
})

test('totals wall time, reported SQL time, and who served the request', async () => {
	vi.useFakeTimers()
	try {
		const { db } = fakeD1({
			served_by_region: 'WNAM',
			served_by_colo: 'SJC',
			served_by_primary: true,
			timings: { sql_duration_ms: 0.5 },
		})
		const real = db.prepare.bind(db)
		db.prepare = (sql: string) => {
			const statement = real(sql)
			for (const method of ['first', 'all'] as const) {
				const call = statement[method].bind(statement) as () => Promise<unknown>
				;(statement as unknown as Record<string, unknown>)[method] =
					async () => {
						await vi.advanceTimersByTimeAsync(40)
						return call()
					}
			}
			return statement
		}
		const timedDb = timeD1RoundTrips(db)
		const { totals } = await inRequest(async () => {
			await timedDb.prepare('one').first()
			await timedDb.prepare('two').all()
			await timedDb.batch([timedDb.prepare('three'), timedDb.prepare('four')])
		})
		expect(totals).toMatchObject({
			calls: 3,
			wallMs: 80,
			reportedCalls: 2,
			reportedWallMs: 40,
			reportedSqlMs: 1.5,
		})
		expect(formatServerTimingHeader(d1RoundTripServerTiming(totals))).toBe(
			'd1;dur=80;desc="3", d1-reported;dur=40;desc="2", d1-sql;dur=2;desc="WNAM-SJC-primary"',
		)
	} finally {
		vi.useRealTimers()
	}
})

test('a failed round trip still rejects for the caller and is counted', async () => {
	const { db } = fakeD1()
	db.exec = async () => {
		throw new Error('D1_ERROR')
	}
	const timedDb = timeD1RoundTrips(db)
	const { totals } = await inRequest(async () => {
		await expect(timedDb.exec('bad')).rejects.toThrow('D1_ERROR')
	})
	expect(totals?.calls).toBe(1)
	expect(totals?.reportedCalls).toBe(0)
})

test('outside a request nothing is recorded and no header is produced', async () => {
	const { db } = fakeD1()
	await expect(
		timeD1RoundTrips(db).prepare('one').all(),
	).resolves.toMatchObject({ results: [{ id: 1 }] })
	expect(d1RoundTripServerTiming(undefined)).toEqual([])
})
