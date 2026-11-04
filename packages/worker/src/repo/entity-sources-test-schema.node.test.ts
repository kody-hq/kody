import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { entitySourcesTableSql } from './entity-sources-test-schema.ts'

function columns(db: DatabaseSync) {
	return db.prepare(`PRAGMA table_info(entity_sources)`).all()
}

test('entitySourcesTableSql matches the migrated entity_sources table', () => {
	const migrated = new DatabaseSync(':memory:')
	applyAllMigrations(migrated, new URL('../../migrations/', import.meta.url))
	const shared = new DatabaseSync(':memory:')
	shared.exec(entitySourcesTableSql)
	expect(columns(shared)).toEqual(columns(migrated))
})
