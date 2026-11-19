/**
 * The mock target's packageStorage().sql must return what hosted
 * StorageRunner sqlQuery returns: the same fields, row cap, warning, and
 * statement rules. The step table is shared with the hosted test.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { storageSqlParitySteps } from '@kody-internal/shared/storage-sql-parity.fixture.ts'
import {
	storageSqlReadWarningMessage,
	storageSqlRowsReadWarnAt,
} from '@kody-internal/shared/storage-sql-read-policy.ts'
import {
	closePackageSqlDbsForSession,
	loadMockSession,
	packageStorageSql,
	sqlParameterSlots,
} from '../src/mock/mock-storage.js'

async function withMockSqlSession(
	sessionId: string,
	run: (
		sql: (
			query: string,
			params?: Array<unknown>,
		) => ReturnType<typeof packageStorageSql>,
	) => Promise<void> | void,
) {
	const cache = await mkdtemp(join(tmpdir(), `kody-sql-${sessionId}-`))
	const env = { ...process.env, KODY_CACHE_DIR: cache }
	try {
		const state = await loadMockSession({ sessionId, env, reset: true })
		await run((query, params = []) =>
			packageStorageSql(state, `local:${sessionId}`, query, params, env),
		)
	} finally {
		closePackageSqlDbsForSession(sessionId)
		await rm(cache, { recursive: true, force: true, maxRetries: 10 })
	}
}

const statementApi = new DatabaseSync(':memory:').prepare('select 1') as {
	columns?: unknown
	iterate?: unknown
	stat?: unknown
}
const hasFullNodeSqlite =
	typeof statementApi.columns === 'function' &&
	typeof statementApi.iterate === 'function' &&
	typeof statementApi.stat === 'function'

test(
	'packageStorageSql matches the hosted parity steps',
	{ skip: !hasFullNodeSqlite && 'needs node:sqlite columns/iterate/stat' },
	async () => {
		await withMockSqlSession('parity', (sql) => {
			for (const step of storageSqlParitySteps) {
				if ('error' in step) {
					assert.throws(() => sql(step.query, step.params), {
						message: step.error,
					})
					continue
				}
				const actual = sql(step.query, step.params)
				const { rows, firstRow, ...expected } = step.result
				const counters = step.mockCounters ?? {
					rowsRead: expected.rowsRead,
					rowsWritten: expected.rowsWritten,
				}
				assert.deepEqual(
					Object.keys(actual).sort(),
					[...Object.keys(expected), 'rows'].sort(),
					step.query,
				)
				const { rows: actualRows, ...actualRest } = actual
				assert.deepEqual(actualRest, { ...expected, ...counters }, step.query)
				if (rows) assert.deepEqual(actualRows, rows, step.query)
				if (firstRow) assert.deepEqual(actualRows[0], firstRow, step.query)
				assert.equal(actualRows.length, expected.rowCount, step.query)
			}
		})
	},
)

test('packageStorageSql keeps RETURNING rows and plain mutation counts', async () => {
	await withMockSqlSession('returning', (sql) => {
		sql('create table notes (id integer primary key, body text)')
		assert.deepEqual(
			sql('insert into notes (body) values (?) returning id, body', ['hi']),
			{
				columns: ['id', 'body'],
				rows: [{ id: 1, body: 'hi' }],
				rowCount: 1,
				rowsRead: 1,
				rowsWritten: 1,
				truncated: false,
				warning: null,
			},
		)
		const literal = sql(`insert into notes (body) values ('returning id')`)
		assert.deepEqual(literal.columns, [])
		assert.deepEqual(literal.rows, [])
		assert.equal(literal.rowsWritten, 1)
		assert.deepEqual(
			sql('delete from notes where id = 1 returning id, body').rows,
			[{ id: 1, body: 'hi' }],
		)
	})
})

test(
	'packageStorageSql warns once a statement examines a million rows',
	{ skip: !hasFullNodeSqlite && 'needs node:sqlite stat()' },
	async () => {
		await withMockSqlSession('warning', (sql) => {
			sql('create table big (v integer)')
			sql(
				`with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ?)
				insert into big (v) select i from seq`,
				[storageSqlRowsReadWarnAt],
			)
			const below = sql('select v from big where v < 0')
			assert.equal(below.rowsRead, storageSqlRowsReadWarnAt)
			assert.equal(
				below.warning,
				storageSqlReadWarningMessage({
					rowsRead: storageSqlRowsReadWarnAt,
					writeFinished: false,
				}),
			)
			const capped = sql('select v from big limit 10')
			assert.equal(capped.warning, null)
		})
	},
)

test('packageStorageSql rejects bindings hosted rejects', async () => {
	await withMockSqlSession('bindings', (sql) => {
		assert.throws(() => sql('select ? as a', [{ nested: true }]), {
			message:
				'storage.sql params only support strings, numbers, booleans, and null.',
		})
		assert.throws(() => sql('select ? as a', [1, 2]), {
			message: 'Wrong number of parameter bindings for SQL query.',
		})
		assert.deepEqual(sql('select ?2 as b, ?1 as a', [1, 2]).rows, [
			{ b: 2, a: 1 },
		])
		assert.deepEqual(sql('select :x as x, ? as y, :x as z', [1, 2]).rows, [
			{ x: 1, y: 2, z: 1 },
		])
	})
})

test('packageStorageSql enforces the hosted 100 bound-parameter cap', async () => {
	await withMockSqlSession('param-cap', (sql) => {
		sql('create table t (a)')
		const values = (count: number) => Array.from({ length: count }, (_, i) => i)
		const insert = (count: number) =>
			`insert into t (a) values ${Array.from({ length: count }, () => '(?)').join(', ')}`
		assert.equal(sql(insert(100), values(100)).rowsWritten, 100)
		assert.throws(() => sql(insert(101), values(101)), /too many SQL variables/)
		assert.deepEqual(sql('select count(*) as n from t').rows, [{ n: 100 }])
	})
})

test('sqlParameterSlots follows SQLite parameter numbering', () => {
	assert.deepEqual(sqlParameterSlots(`select ?, '?', "?" -- ?`), [
		{ index: 1, name: null },
	])
	assert.deepEqual(sqlParameterSlots('select ?3, ?, :a, @b, :a'), [
		{ index: 1, name: null },
		{ index: 2, name: null },
		{ index: 3, name: null },
		{ index: 4, name: null },
		{ index: 5, name: 'a' },
		{ index: 6, name: 'b' },
	])
	assert.deepEqual(sqlParameterSlots('select 1'), [])
})
