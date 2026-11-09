import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

test('file grants migration preserves existing grants, permissions and credential flags', () => {
	using db = new DatabaseSync(':memory:')
	const directory = new URL('../../migrations/', import.meta.url)
	for (const name of readdirSync(directory)
		.filter((name) => name.endsWith('.sql') && name < '0236')
		.sort()) {
		// The squashed baseline already contains a few columns from later migrations.
		const sql = readFileSync(new URL(name, directory), 'utf8')
		try {
			db.exec(sql)
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes('duplicate column name')
			)
				throw error
			for (const statement of sql
				.split('\n')
				.filter((line) => !line.trimStart().startsWith('--'))
				.join('\n')
				.split(';')
				.filter((part) => part.trim())) {
				try {
					db.exec(statement)
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!error.message.includes('duplicate column name')
					)
						throw error
				}
			}
		}
	}
	db.exec(`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at, allow_unmappable_credential_changes)
		VALUES ('existing', 'org', 'credential', 'credential', 'user', 'person', 'manage', 'person', 'now', 'now', 1);
		INSERT INTO grant_permissions (grant_id, permission) VALUES ('existing', 'credential:read');`)
	const before = db.prepare('SELECT * FROM grants').all()
	const permissions = db.prepare('SELECT * FROM grant_permissions').all()
	db.exec(readFileSync(new URL('0236-file-resources.sql', directory), 'utf8'))
	expect(db.prepare('SELECT * FROM grants').all()).toEqual(before)
	expect(db.prepare('SELECT * FROM grant_permissions').all()).toEqual(
		permissions,
	)
	db.exec(`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at)
		VALUES ('file', 'org', 'file', 'file-id', 'user', 'person', 'read', 'person', 'now', 'now')`)
	expect(() =>
		db.exec(`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at)
		VALUES ('duplicate', 'org', 'file', 'file-id', 'user', 'person', 'read', 'person', 'now', 'now')`),
	).toThrow('UNIQUE constraint failed')
})
