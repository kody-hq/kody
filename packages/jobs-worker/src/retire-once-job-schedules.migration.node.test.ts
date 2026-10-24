import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migration = readFileSync(
	new URL('../migrations/0008-retire-once-job-schedules.sql', import.meta.url),
	'utf8',
)

function createDatabase() {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE jobs (
			id TEXT PRIMARY KEY NOT NULL,
			schedule_json TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			last_run_at TEXT,
			deleted_at TEXT
		);
	`)
	return db
}

test('0008 deletes retired once jobs', () => {
	const db = createDatabase()
	db.prepare(
		`INSERT INTO jobs (id, schedule_json, enabled, last_run_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run('disabled', '{"type":"once"}', 0, null, null)
	db.prepare(
		`INSERT INTO jobs (id, schedule_json, enabled, last_run_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run('ran', '{"type":"once"}', 1, '2026-01-01T00:00:00Z', null)
	db.prepare(
		`INSERT INTO jobs (id, schedule_json, enabled, last_run_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run('deleted', '{"type":"once"}', 1, null, '2026-01-01T00:00:00Z')
	db.prepare(
		`INSERT INTO jobs (id, schedule_json, enabled, last_run_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run('recurring', '{"type":"interval","every":"1h"}', 1, null, null)
	db.exec(migration)

	expect(db.prepare(`SELECT id FROM jobs ORDER BY id`).all()).toEqual([
		{ id: 'recurring' },
	])
})

test('0008 fails when an enabled, unrun once job remains', () => {
	const db = createDatabase()
	db.prepare(
		`INSERT INTO jobs (id, schedule_json, enabled, last_run_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run('active-once', '{"type":"once"}', 1, null, null)

	expect(() => db.exec(migration)).toThrow('CHECK constraint failed: 0')
})
