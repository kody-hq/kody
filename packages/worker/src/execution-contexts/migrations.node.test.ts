import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const tablesMigration = '0189-execution-contexts.sql'
const grantsMigration = '0190-grants-execution-context-resource-type.sql'

function migrationNames() {
	return readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql'))
		.sort()
}

function applyMigrations(
	sqlite: DatabaseSync,
	include: (name: string) => boolean,
) {
	for (const name of migrationNames().filter(include)) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
}

function databaseBefore(fileName: string) {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyMigrations(sqlite, (name) => name < fileName)
	return sqlite
}

function insertGrant(
	sqlite: DatabaseSync,
	grant: {
		id: string
		resourceType: string
		resourceId: string
		subjectType?: 'user' | 'team'
		subjectId?: string
		preset?: string | null
		deletedAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, 'org_acme', ?, ?, ?, ?, ?, 'user_test_1', '2026-10-01', '2026-10-02', ?)`,
		)
		.run(
			grant.id,
			grant.resourceType,
			grant.resourceId,
			grant.subjectType ?? 'user',
			grant.subjectId ?? 'user_test_2',
			grant.preset === undefined ? 'use' : grant.preset,
			grant.deletedAt ?? null,
		)
}

function grantsSnapshot(sqlite: DatabaseSync) {
	const grants = sqlite.prepare(`SELECT * FROM grants ORDER BY id`).all()
	const permissions = sqlite
		.prepare(`SELECT * FROM grant_permissions ORDER BY grant_id, permission`)
		.all()
	const indexes = sqlite
		.prepare(
			`SELECT name, sql FROM sqlite_master
			WHERE type = 'index' AND tbl_name = 'grants' AND sql IS NOT NULL
			ORDER BY name`,
		)
		.all()
	return {
		grantCount: grants.length,
		permissionCount: permissions.length,
		checksum: createHash('sha256')
			.update(JSON.stringify({ grants, permissions }))
			.digest('hex'),
		indexes,
	}
}

function columnNames(sqlite: DatabaseSync, table: string) {
	return (
		sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
			name: string
		}>
	).map((column) => column.name)
}

test('the grants rebuild keeps every grant, permission, and index and admits execution_context', () => {
	const sqlite = databaseBefore(grantsMigration)
	insertGrant(sqlite, {
		id: 'g-live',
		resourceType: 'package',
		resourceId: 'p1',
	})
	insertGrant(sqlite, {
		id: 'g-team',
		resourceType: 'credential',
		resourceId: 'c1',
		subjectType: 'team',
		subjectId: 'team_core',
		preset: null,
	})
	insertGrant(sqlite, {
		id: 'g-deleted',
		resourceType: 'app',
		resourceId: 'p1',
		preset: 'manage',
		deletedAt: '2026-10-03',
	})
	insertGrant(sqlite, {
		id: 'g-org',
		resourceType: 'org',
		resourceId: 'org_acme',
	})
	for (const [grantId, permission] of [
		['g-team', 'secret:read'],
		['g-team', 'secret:use'],
		['g-org', 'package:create'],
		['g-orphan', 'package:read'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
			)
			.run(grantId, permission)
	}
	expect(() =>
		insertGrant(sqlite, {
			id: 'g-ec-early',
			resourceType: 'execution_context',
			resourceId: 'ec_1',
		}),
	).toThrow(/CHECK constraint failed/)

	const before = grantsSnapshot(sqlite)
	expect(
		before.indexes.map((index) => (index as { name: string }).name),
	).toEqual(['grants_live_subject', 'grants_subject'])
	applyMigrations(sqlite, (name) => name === grantsMigration)
	expect(grantsSnapshot(sqlite)).toEqual(before)

	insertGrant(sqlite, {
		id: 'g-ec',
		resourceType: 'execution_context',
		resourceId: 'ec_1',
	})
	expect(() =>
		insertGrant(sqlite, {
			id: 'g-ec-duplicate',
			resourceType: 'execution_context',
			resourceId: 'ec_1',
		}),
	).toThrow(/UNIQUE constraint failed/)
	expect(() =>
		insertGrant(sqlite, {
			id: 'g-bad',
			resourceType: 'workspace',
			resourceId: 'w1',
		}),
	).toThrow(/CHECK constraint failed/)
	const leftovers = sqlite
		.prepare(
			`SELECT name FROM sqlite_master WHERE name IN ('grants_next', '__grants_rebuild_counts', '__migration_assertions')`,
		)
		.all()
	expect(leftovers).toEqual([])
})

test('execution context tables exist with their columns and unique rules', () => {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyMigrations(sqlite, () => true)
	expect(migrationNames()).toContain(tablesMigration)

	expect(columnNames(sqlite, 'execution_contexts')).toEqual([
		'id',
		'org_id',
		'operator_user_id',
		'all_members',
		'name',
		'public_key_jwk',
		'thumbprint',
		'created_at',
		'revoked_at',
		'revoked_reason',
		'last_seen_at',
		'client_name',
		'client_version',
		'capabilities_json',
		'grant_json',
		'grant_version',
	])
	expect(columnNames(sqlite, 'execution_context_opt_ins')).toEqual([
		'context_id',
		'user_id',
		'org_id',
		'created_at',
	])
	expect(columnNames(sqlite, 'execution_context_org_attachments')).toEqual([
		'context_id',
		'org_id',
		'attached_by_user_id',
		'all_members',
		'narrowing_json',
		'created_at',
	])
	expect(columnNames(sqlite, 'execution_context_chains')).toEqual([
		'org_id',
		'user_id',
		'strict',
		'version',
		'updated_at',
		'updated_by_kind',
		'updated_by_label',
	])
	expect(columnNames(sqlite, 'execution_context_chain_entries')).toEqual([
		'org_id',
		'user_id',
		'position',
		'context_id',
	])
	expect(
		columnNames(sqlite, 'execution_context_registration_challenges'),
	).toEqual(['challenge_hash', 'user_id', 'org_id', 'expires_at'])

	const insertContext = sqlite.prepare(
		`INSERT INTO execution_contexts (
			id, org_id, operator_user_id, name, public_key_jwk, thumbprint, created_at
		) VALUES (?, ?, 'user_test_1', ?, '{}', ?, '2026-10-01')`,
	)
	insertContext.run('ec_1', 'org_acme', 'laptop', 'thumb-1')
	insertContext.run('ec_2', 'org_other', 'laptop', 'thumb-2')
	expect(() =>
		insertContext.run('ec_3', 'org_acme', 'laptop', 'thumb-3'),
	).toThrow(/UNIQUE constraint failed/)
	expect(() =>
		insertContext.run('ec_4', 'org_acme', 'build-server', 'thumb-1'),
	).toThrow(/UNIQUE constraint failed/)
	const defaults = sqlite
		.prepare(
			`SELECT all_members, grant_version FROM execution_contexts WHERE id = 'ec_1'`,
		)
		.get()
	expect(defaults).toEqual({ all_members: 0, grant_version: 0 })

	const insertEntry = sqlite.prepare(
		`INSERT INTO execution_context_chain_entries (org_id, user_id, position, context_id)
		VALUES ('org_acme', 'user_test_1', ?, ?)`,
	)
	insertEntry.run(0, 'ec_1')
	insertEntry.run(1, null)
	expect(() => insertEntry.run(2, 'ec_1')).toThrow(/UNIQUE constraint failed/)
	expect(() => insertEntry.run(1, 'ec_2')).toThrow(/UNIQUE constraint failed/)
	expect(() => insertEntry.run(3, null)).toThrow(/UNIQUE constraint failed/)

	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO execution_context_chains (org_id, user_id, updated_at, updated_by_kind)
				VALUES ('org_acme', 'user_test_1', '2026-10-01', 'robot')`,
			)
			.run(),
	).toThrow(/CHECK constraint failed/)

	const indexes = (
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'index' AND tbl_name LIKE 'execution_context%' AND sql IS NOT NULL
				ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)
	expect(indexes).toEqual([
		'execution_context_chain_entries_cloud_once',
		'execution_context_chain_entries_context',
		'execution_context_chain_entries_context_once',
		'execution_context_chain_entries_user',
		'execution_context_chains_user',
		'execution_context_opt_ins_org_user',
		'execution_context_opt_ins_user',
		'execution_context_org_attachments_attached_by',
		'execution_context_org_attachments_org',
		'execution_context_registration_challenges_expires',
		'execution_context_registration_challenges_user',
		'execution_contexts_operator',
		'execution_contexts_org_name',
		'execution_contexts_thumbprint',
	])
})
