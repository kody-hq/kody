import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	accountOperatorOwnedD1Surfaces,
	accountUserDataTargets,
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	getAccountExportExcludedD1Surfaces,
	isExcludedFromAccountExport,
	type UserScopedDataTarget,
} from './data-targets.ts'

function createMigratedDb() {
	const db = new DatabaseSync(':memory:')
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))
	return db
}

function columnNames(db: DatabaseSync, table: string) {
	const columns = db
		.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`)
		.all() as Array<{ name: string }>
	return columns.map((column) => column.name)
}

function matchFor(target: UserScopedDataTarget) {
	return buildUserScopedTargetMatch({
		target,
		mcpUserId: ownerIdFromStored('user-aaa'),
		dbUserId: 42,
	})
}

test('operator-owned tables are explicit deletion/export exclusions', () => {
	using db = createMigratedDb()
	const expectedTables = [
		'platform_oauth_apps',
		'platform_provider_marks',
		'repo_session_storage_bucket_cursor',
		'system_email_attachments',
		'system_email_delivery_events',
		'system_email_messages',
		'system_email_threads',
	]
	expect(
		accountOperatorOwnedD1Surfaces.map((surface) => surface.table).sort(),
	).toEqual(expectedTables)
	for (const table of expectedTables) {
		expect(columnNames(db, table)).not.toContain('user_id')
		expect(
			accountUserDataTargets.some(
				(target) => 'table' in target && target.table === table,
			),
		).toBe(false)
	}
	expect(getAccountExportExcludedD1Surfaces()).toEqual(
		expect.arrayContaining(
			expectedTables.map((table) =>
				expect.objectContaining({
					name: table,
					reason: expect.stringContaining(
						table === 'platform_oauth_apps'
							? 'Operator-provisioned built-in OAuth app'
							: table === 'platform_provider_marks'
								? 'Operator-owned provider brand marks'
								: table.startsWith('repo_session_')
									? 'Platform-owned'
									: 'operator-owned system email',
					),
				}),
			),
		),
	)
})

test('deleting a member anonymizes follow attribution and org purge still deletes owned follows', () => {
	const creator = accountUserDataTargets.find(
		(target) =>
			target.kind === 'replace_user_column' &&
			target.table === 'follows' &&
			target.matchColumn === 'creator_user_id',
	)
	expect(creator).toMatchObject({
		setColumn: 'creator_user_id',
		value: 'deleted-user',
	})
	if (!creator) return
	expect(buildUserScopedDeleteOrUpdateSql(matchFor(creator))).toEqual({
		sql: `UPDATE follows
						SET creator_user_id = ?
						WHERE creator_user_id = ?`,
		params: ['deleted-user', 'user-aaa'],
	})
	expect(isExcludedFromAccountExport(creator)).toBe(false)

	const owned = accountUserDataTargets.find(
		(target) =>
			target.kind === 'user_columns' &&
			target.table === 'follows' &&
			target.columns.includes('follower_org_id'),
	)
	expect(owned).toMatchObject({
		columns: ['follower_org_id'],
		includeInExport: false,
	})
	if (!owned) return
	expect(buildUserScopedDeleteOrUpdateSql(matchFor(owned)).sql).toBe(
		'DELETE FROM follows WHERE follower_org_id = ?',
	)
})

test('account deletion statements never bind a LIKE or GLOB pattern (D1 caps patterns at 50 bytes)', () => {
	// A stable user id is 64 hex chars; wrapped in quotes and wildcards it is
	// 68 bytes, which D1 rejects with "LIKE or GLOB pattern too complex". The
	// production purge lane failed on exactly this until the JSON-column
	// target switched to instr().
	const stableUserId = ownerIdFromStored('f').repeat(64)
	for (const target of accountUserDataTargets) {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: stableUserId,
			dbUserId: 1,
		})
		const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
		expect(sql).not.toMatch(/\b(LIKE|GLOB)\b/iu)
		for (const param of params) {
			if (typeof param !== 'string') continue
			expect(param.startsWith('%') || param.endsWith('%')).toBe(false)
		}
	}
})
