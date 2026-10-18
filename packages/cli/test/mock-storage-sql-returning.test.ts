/**
 * mock packageStorage().sql must return RETURNING rows the same way hosted
 * storage-runner sqlQuery does — not drop them because the statement is a
 * mutation verb.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	closePackageSqlDbsForSession,
	loadMockSession,
	packageStorageSql,
	sqlHasReturningClause,
	statementYieldsRows,
} from '../src/mock/mock-storage.js'
import { DatabaseSync } from 'node:sqlite'

test('statementYieldsRows uses columns(), not a returning regex', () => {
	const db = new DatabaseSync(':memory:')
	try {
		db.exec('create table notes (id integer primary key, body text)')
		const returning = db.prepare(
			'insert into notes (body) values (?) returning id, body',
		)
		const plain = db.prepare('insert into notes (body) values (?)')
		const select = db.prepare('select id, body from notes')
		const literalReturning = db.prepare(
			`insert into notes (body) values ('returning id')`,
		)
		if (typeof returning.columns !== 'function') {
			// Node < 22.16: columns() missing — statementYieldsRows returns null.
			assert.equal(statementYieldsRows(returning), null)
			assert.equal(statementYieldsRows(plain), null)
			return
		}
		assert.equal(statementYieldsRows(returning), true)
		assert.equal(statementYieldsRows(plain), false)
		assert.equal(statementYieldsRows(select), true)
		// Literal "returning" in a string must not decide the path — columns() does.
		assert.equal(statementYieldsRows(literalReturning), false)
	} finally {
		db.close()
	}
})

test('sqlHasReturningClause ignores returning inside string literals', () => {
	assert.equal(
		sqlHasReturningClause(
			'insert into notes (body) values (?) returning id, body',
		),
		true,
	)
	assert.equal(
		sqlHasReturningClause(`insert into notes (body) values ('returning id')`),
		false,
	)
	assert.equal(
		sqlHasReturningClause('insert into notes (body) values (?)'),
		false,
	)
})

test('packageStorageSql returns INSERT RETURNING rows', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-sql-returning-'))
	const env = { ...process.env, KODY_CACHE_DIR: cache }
	try {
		const state = await loadMockSession({
			sessionId: 'returning',
			env,
			reset: true,
		})
		const pkg = 'local:returning'
		assert.deepEqual(
			packageStorageSql(
				state,
				pkg,
				'create table notes (id integer primary key, body text)',
				[],
				env,
			),
			{ rows: [], changes: 0 },
		)
		const inserted = packageStorageSql(
			state,
			pkg,
			'insert into notes (body) values (?) returning id, body',
			['hi'],
			env,
		)
		assert.deepEqual(inserted.rows, [{ id: 1, body: 'hi' }])
		assert.equal(inserted.changes, undefined)
		const selected = packageStorageSql(
			state,
			pkg,
			'select id, body from notes',
			[],
			env,
		)
		assert.deepEqual(selected.rows, [{ id: 1, body: 'hi' }])
		const emptyReturning = packageStorageSql(
			state,
			pkg,
			'update notes set body = ? where id = 99 returning id, body',
			['nope'],
			env,
		)
		assert.deepEqual(emptyReturning, { rows: [] })
	} finally {
		closePackageSqlDbsForSession('returning')
		await rm(cache, { recursive: true, force: true })
	}
})

test('packageStorageSql UPDATE/DELETE RETURNING and plain mutations', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-sql-returning-dml-'))
	const env = { ...process.env, KODY_CACHE_DIR: cache }
	try {
		const state = await loadMockSession({
			sessionId: 'returning-dml',
			env,
			reset: true,
		})
		const pkg = 'local:returning-dml'
		packageStorageSql(
			state,
			pkg,
			'create table notes (id integer primary key, body text)',
			[],
			env,
		)
		packageStorageSql(
			state,
			pkg,
			'insert into notes (body) values (?), (?)',
			['a', 'b'],
			env,
		)
		const updated = packageStorageSql(
			state,
			pkg,
			'update notes set body = ? where id = 1 returning id, body',
			['aa'],
			env,
		)
		assert.deepEqual(updated.rows, [{ id: 1, body: 'aa' }])
		const deleted = packageStorageSql(
			state,
			pkg,
			'delete from notes where id = 2 returning id, body',
			[],
			env,
		)
		assert.deepEqual(deleted.rows, [{ id: 2, body: 'b' }])
		const plain = packageStorageSql(
			state,
			pkg,
			'insert into notes (body) values (?)',
			['c'],
			env,
		)
		assert.deepEqual(plain.rows, [])
		assert.equal(plain.changes, 1)
	} finally {
		closePackageSqlDbsForSession('returning-dml')
		await rm(cache, { recursive: true, force: true })
	}
})
