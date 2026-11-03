import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { communityForksTableSql } from './community-forks-test-schema.ts'

function tableShape(db: DatabaseSync) {
	const sql = db
		.prepare(
			`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'community_forks'`,
		)
		.get() as { sql: string }
	return {
		columns: db.prepare(`PRAGMA table_info(community_forks)`).all(),
		checks: sql.sql.match(/CHECK \(.+\)/g),
	}
}

test('communityForksTableSql matches the migrated community_forks table', () => {
	const migrated = new DatabaseSync(':memory:')
	applyAllMigrations(migrated, new URL('../../migrations/', import.meta.url))
	const shared = new DatabaseSync(':memory:')
	shared.exec(communityForksTableSql)
	expect(tableShape(shared)).toEqual(tableShape(migrated))
})
