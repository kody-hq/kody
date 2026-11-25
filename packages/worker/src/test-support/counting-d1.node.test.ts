import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createCountingD1 } from './counting-d1.ts'
import { createD1FromSqlite } from './create-d1-from-sqlite.ts'

test('createCountingD1 counts statements on a createD1FromSqlite database', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
	const counting = createCountingD1(createD1FromSqlite(sqlite))
	const { db } = counting
	await db.prepare('INSERT INTO items (name) VALUES (?)').bind('a').run()
	const row = await db
		.prepare('SELECT name FROM items WHERE id = ?')
		.bind(1)
		.first<{ name: string }>()
	expect(row).toEqual({ name: 'a' })
	expect(counting.statements).toEqual([
		'INSERT INTO items (name) VALUES (?)',
		'SELECT name FROM items WHERE id = ?',
	])
})
