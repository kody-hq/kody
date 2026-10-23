import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	countStorageSqlRows,
	readStorageSqlRowsPage,
	readStorageSqlSchema,
	writeStorageSqlRows,
	writeStorageSqlSchema,
	type StorageSqlExec,
	type StorageSqlValue,
} from './storage-runner-sql-dump.ts'

function createExec(db: DatabaseSync): StorageSqlExec {
	return (query, ...params) => {
		const statement = db.prepare(query)
		const isRead = /^\s*(select|pragma|with)\b/i.test(query)
		const rows = isRead
			? (statement.all(...(params as Array<SQLInputValue>)) as Array<
					Record<string, StorageSqlValue>
				>)
			: (statement.run(...(params as Array<SQLInputValue>)), [])
		const columnNames = isRead
			? statement.columns().map((column) => column.name)
			: []
		return { toArray: () => rows, columnNames }
	}
}

function copyAll(source: StorageSqlExec, target: StorageSqlExec, pageSize = 2) {
	const schema = readStorageSqlSchema(source)
	writeStorageSqlSchema(target, { objects: schema, phase: 'tables' })
	for (const object of schema) {
		if (object.type !== 'table') continue
		let cursor: number | null = null
		do {
			const page = readStorageSqlRowsPage(source, {
				table: object.name,
				cursor,
				pageSize,
			})
			writeStorageSqlRows(target, {
				table: object.name,
				columns: page.columns,
				rows: page.rows,
			})
			cursor = page.nextCursor
		} while (cursor !== null)
	}
	writeStorageSqlSchema(target, { objects: schema, phase: 'finish' })
}

test('copies tables, indexes, triggers, and rows with stable rowids', () => {
	const sourceDb = new DatabaseSync(':memory:')
	const targetDb = new DatabaseSync(':memory:')
	const source = createExec(sourceDb)
	const target = createExec(targetDb)
	sourceDb.exec(`
		CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, blob BLOB);
		CREATE INDEX notes_body ON notes (body);
		CREATE TABLE tags (name TEXT PRIMARY KEY, uses INTEGER) WITHOUT ROWID;
		CREATE TABLE audit (note_id INTEGER);
		CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN
			INSERT INTO audit (note_id) VALUES (new.id);
		END;
	`)
	for (const id of [3, 7, 9, 20, 41]) {
		sourceDb
			.prepare('INSERT INTO notes (id, body, blob) VALUES (?, ?, ?)')
			.run(id, `note ${id}`, new Uint8Array([id, 1, 2]))
	}
	sourceDb.prepare(`INSERT INTO tags VALUES ('a', 1), ('b', 2), ('c', 3)`).run()

	copyAll(source, target)

	expect(countStorageSqlRows(target)).toEqual(countStorageSqlRows(source))
	expect(countStorageSqlRows(target)).toEqual({ audit: 5, notes: 5, tags: 3 })
	expect(
		targetDb.prepare('SELECT id, body, blob FROM notes ORDER BY id').all(),
	).toEqual(
		sourceDb.prepare('SELECT id, body, blob FROM notes ORDER BY id').all(),
	)
	expect(
		readStorageSqlSchema(target).map(({ type, name }) => `${type}:${name}`),
	).toEqual([
		'table:audit',
		'table:notes',
		'table:tags',
		'index:notes_body',
		'trigger:notes_audit',
	])
	targetDb.prepare(`INSERT INTO notes (id, body) VALUES (100, 'later')`).run()
	expect(countStorageSqlRows(target).audit).toBe(6)
})

test('refuses to replay a schema into storage that already has tables', () => {
	const sourceDb = new DatabaseSync(':memory:')
	const targetDb = new DatabaseSync(':memory:')
	sourceDb.exec('CREATE TABLE a (x)')
	targetDb.exec('CREATE TABLE b (y)')
	expect(() =>
		writeStorageSqlSchema(createExec(targetDb), {
			objects: readStorageSqlSchema(createExec(sourceDb)),
			phase: 'tables',
		}),
	).toThrow('Target storage already has SQL tables.')
})
