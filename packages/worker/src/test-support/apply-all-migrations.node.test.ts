import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from './apply-all-migrations.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

// Seed rows stamped with CURRENT_TIMESTAMP differ between any two replays.
function normalizeTimestamps(row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(row).map(([column, value]) => [
			column,
			typeof value === 'string' &&
			/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(value)
				? '<timestamp>'
				: value,
		]),
	)
}

function snapshot(db: DatabaseSync) {
	const objects = db
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		)
		.all() as Array<{ type: string; name: string }>
	const rows = Object.fromEntries(
		objects
			.filter((object) => object.type === 'table')
			.map((table) => [
				table.name,
				db
					.prepare(`SELECT * FROM "${table.name}" ORDER BY 1`)
					.all()
					.map(normalizeTimestamps),
			]),
	)
	return { objects, rows }
}

function replayEveryMigration(db: DatabaseSync, before?: string) {
	// Seed a table first so applyAllMigrations takes its replay path.
	db.exec('CREATE TABLE replay_marker (id INTEGER)')
	applyAllMigrations(db, migrationsDirectory, { before })
	db.exec('DROP TABLE replay_marker')
}

test('a copied migration image matches replaying every migration, seed rows included', () => {
	const replayed = new DatabaseSync(':memory:')
	replayEveryMigration(replayed)
	const copied = new DatabaseSync(':memory:')
	applyAllMigrations(copied, migrationsDirectory)
	const copiedAgain = new DatabaseSync(':memory:')
	applyAllMigrations(copiedAgain, migrationsDirectory)

	expect(snapshot(copied)).toEqual(snapshot(replayed))
	expect(snapshot(copiedAgain)).toEqual(snapshot(replayed))
})

test('databases built from the same image do not share writes', () => {
	const first = new DatabaseSync(':memory:')
	applyAllMigrations(first, migrationsDirectory)
	first.exec('CREATE TABLE only_in_first (id INTEGER)')

	const second = new DatabaseSync(':memory:')
	applyAllMigrations(second, migrationsDirectory)

	expect(
		second
			.prepare("SELECT name FROM sqlite_master WHERE name = 'only_in_first'")
			.get(),
	).toBeUndefined()
})

test('`before` images stop at the requested migration', () => {
	const fileNames = readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()
	const before = fileNames[Math.floor(fileNames.length / 2)]!

	const partial = new DatabaseSync(':memory:')
	applyAllMigrations(partial, migrationsDirectory, { before })
	const replayedPartial = new DatabaseSync(':memory:')
	replayEveryMigration(replayedPartial, before)
	const full = new DatabaseSync(':memory:')
	applyAllMigrations(full, migrationsDirectory)

	expect(snapshot(partial)).toEqual(snapshot(replayedPartial))
	expect(snapshot(partial)).not.toEqual(snapshot(full))
})

test('a database that already has tables keeps them and gets every migration', () => {
	const db = new DatabaseSync(':memory:')
	db.exec('CREATE TABLE existing_rows (id INTEGER)')
	db.exec('INSERT INTO existing_rows VALUES (7)')
	applyAllMigrations(db, migrationsDirectory)

	expect(db.prepare('SELECT id FROM existing_rows').all()).toEqual([{ id: 7 }])
	const fresh = new DatabaseSync(':memory:')
	applyAllMigrations(fresh, migrationsDirectory)
	db.exec('DROP TABLE existing_rows')
	expect(snapshot(db)).toEqual(snapshot(fresh))
})

test('file-backed databases get migrations written to their file', () => {
	const directory = mkdtempSync(join(tmpdir(), 'kody-migrations-'))
	try {
		const path = join(directory, 'app.sqlite')
		const db = new DatabaseSync(path)
		applyAllMigrations(db, migrationsDirectory)
		db.close()

		const reopened = new DatabaseSync(path)
		const fresh = new DatabaseSync(':memory:')
		applyAllMigrations(fresh, migrationsDirectory)
		expect(snapshot(reopened)).toEqual(snapshot(fresh))
		reopened.close()
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
