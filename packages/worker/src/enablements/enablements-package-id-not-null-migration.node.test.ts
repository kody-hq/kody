import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0172-enablements-package-id-not-null.sql'

const approvedTombstoneIds = [
	'a572c222-bfbb-4dbd-a640-0ca53c8d86c3',
	'9ab4ec1f-275e-4d2c-a1ff-dce0300846a2',
] as const

function migrationSql() {
	return readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8')
}

function applyMigrationFile(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((entry) => entry.endsWith('.sql'))
		.sort()) {
		if (name >= fileName) continue
		applyMigrationFile(db, name)
	}
}

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, migrationFileName)
	return sqlite
}

function insertEnablement(
	db: DatabaseSync,
	input: {
		id: string
		packageId: string | null
		state: 'on' | 'paused' | 'off'
		triggerName?: string
	},
) {
	db.prepare(
		`INSERT INTO enablements (
			id, org_id, package_id, trigger_kind, trigger_name, instance_id,
			enabler_user_id, state, origin, enabled_at, updated_at, disabled_at
		) VALUES (?, 'org-1', ?, 'cron', ?, ?, 'person-1', ?, 'migrated', ?, ?, ?)`,
	).run(
		input.id,
		input.packageId,
		input.triggerName ?? 'legacy-cron',
		`instance-${input.id}`,
		input.state,
		'2026-10-11T09:00:00.000Z',
		'2026-10-11T21:20:00.000Z',
		input.state === 'off' ? '2026-10-11T21:20:00.000Z' : null,
	)
}

function packageIdNotNull(db: DatabaseSync) {
	const row = db
		.prepare(`PRAGMA table_info(enablements)`)
		.all()
		.find((column) => (column as { name: string }).name === 'package_id') as
		| { notnull: number }
		| undefined
	return row?.notnull === 1
}

function enablementIndexes(db: DatabaseSync) {
	return db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'index' AND tbl_name = 'enablements' AND sql IS NOT NULL
			 ORDER BY name`,
		)
		.all()
		.map((row) => (row as { name: string }).name)
}

test('0172 deletes the two approved NULL off tombstones and makes package_id NOT NULL', () => {
	const sqlite = databaseBeforeMigration()
	insertEnablement(sqlite, {
		id: approvedTombstoneIds[0],
		packageId: null,
		state: 'off',
		triggerName: 'Daily Hugging Face trending models',
	})
	insertEnablement(sqlite, {
		id: approvedTombstoneIds[1],
		packageId: null,
		state: 'off',
		triggerName: 'InspectIT demo health watch',
	})
	insertEnablement(sqlite, {
		id: 'keep-live',
		packageId: 'pkg-keep',
		state: 'on',
		triggerName: 'keep-cron',
	})

	expect(packageIdNotNull(sqlite)).toBe(false)
	sqlite.exec(migrationSql())

	expect(packageIdNotNull(sqlite)).toBe(true)
	expect(
		sqlite.prepare(`SELECT id FROM enablements WHERE package_id IS NULL`).all(),
	).toEqual([])
	expect(
		sqlite
			.prepare(`SELECT id, package_id, state FROM enablements ORDER BY id`)
			.all(),
	).toEqual([{ id: 'keep-live', package_id: 'pkg-keep', state: 'on' }])
	expect(enablementIndexes(sqlite)).toEqual([
		'enablements_email_sender_one_live',
		'enablements_enabler',
		'enablements_instance',
		'enablements_migrated_instance',
		'enablements_subscription_sender',
		'enablements_webhook_one_live',
	])
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])

	expect(() =>
		sqlite.exec(`
			INSERT INTO enablements (
				id, org_id, package_id, trigger_kind, trigger_name, instance_id,
				enabler_user_id, state, origin, enabled_at, updated_at
			) VALUES (
				'null-pkg', 'org-1', NULL, 'cron', 'x', 'i', 'person-1', 'off',
				'enabled', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z'
			)
		`),
	).toThrow(/NOT NULL constraint failed: enablements\.package_id/)
})

test('0172 aborts when a NULL package_id row is still live', () => {
	const sqlite = databaseBeforeMigration()
	insertEnablement(sqlite, {
		id: 'live-null',
		packageId: null,
		state: 'on',
	})

	expect(() => sqlite.exec(migrationSql())).toThrow(/CHECK constraint failed/)
	expect(packageIdNotNull(sqlite)).toBe(false)
	expect(sqlite.prepare(`SELECT id, state FROM enablements`).all()).toEqual([
		{ id: 'live-null', state: 'on' },
	])
})

test('0172 aborts when an unexpected NULL off tombstone exists', () => {
	const sqlite = databaseBeforeMigration()
	insertEnablement(sqlite, {
		id: approvedTombstoneIds[0],
		packageId: null,
		state: 'off',
	})
	insertEnablement(sqlite, {
		id: 'unexpected-null-off',
		packageId: null,
		state: 'off',
	})

	expect(() => sqlite.exec(migrationSql())).toThrow(/CHECK constraint failed/)
	expect(
		sqlite
			.prepare(
				`SELECT id FROM enablements WHERE package_id IS NULL ORDER BY id`,
			)
			.all()
			.map((row) => (row as { id: string }).id),
	).toEqual([approvedTombstoneIds[0], 'unexpected-null-off'])
})

test('0172 succeeds on a clean database with no NULL package_id rows', () => {
	const sqlite = databaseBeforeMigration()
	insertEnablement(sqlite, {
		id: 'already-clean',
		packageId: 'pkg-1',
		state: 'on',
	})
	sqlite.exec(migrationSql())
	expect(packageIdNotNull(sqlite)).toBe(true)
	expect(sqlite.prepare(`SELECT package_id FROM enablements`).get()).toEqual({
		package_id: 'pkg-1',
	})
})
