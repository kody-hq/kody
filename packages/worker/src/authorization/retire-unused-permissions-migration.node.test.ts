import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0239-retire-unused-permissions.sql'

type Row = Record<string, string | number | null>

function insert(sqlite: DatabaseSync, table: string, values: Row) {
	const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string
		type: string
		notnull: number
		dflt_value: string | null
		pk: number
	}>
	const row: Row = { ...values }
	for (const column of columns) {
		if (column.name in row) continue
		if (column.notnull && column.dflt_value === null) {
			row[column.name] = /INT/i.test(column.type) ? 0 : `${column.name}-x`
		}
	}
	const names = Object.keys(row)
	sqlite
		.prepare(
			`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
		)
		.run(...names.map((name) => row[name] ?? null))
}

function migratedDatabase(seed: (sqlite: DatabaseSync) => void) {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrationsDirectory)
		.filter((entry) => entry.endsWith('.sql') && entry < migrationFileName)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
	seed(sqlite)
	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)
	return sqlite
}

function value(sqlite: DatabaseSync, sql: string) {
	return Object.values(sqlite.prepare(sql).get() as Row)[0]
}

function grantPermissions(sqlite: DatabaseSync, grantId: string) {
	return (
		sqlite
			.prepare(
				`SELECT permission FROM grant_permissions WHERE grant_id = ? ORDER BY permission`,
			)
			.all(grantId) as Array<{ permission: string }>
	).map((row) => row.permission)
}

test('0239 strips retired permissions from stored scopes and grants', () => {
	const sqlite = migratedDatabase((db) => {
		insert(db, 'api_tokens', {
			id: 'token-full',
			scopes_json: JSON.stringify([
				'app:create',
				'email:create',
				'job:create',
				'job:read',
				'package:read',
			]),
		})
		insert(db, 'api_tokens', {
			id: 'token-clean',
			scopes_json: JSON.stringify(['package:read', 'job:read']),
		})
		insert(db, 'cli_credential_bootstrap_codes', {
			id: 'code-a',
			scopes_json: JSON.stringify(['job:create', 'org:execute']),
		})
		insert(db, 'enablements', {
			id: 'enablement-a',
			trigger_kind: 'cron',
			state: 'on',
			origin: 'enabled',
			enabler_scopes_json: JSON.stringify(['email:create', 'job:execute']),
		})
		insert(db, 'invites', {
			id: 'invite-org',
			kind: 'grant',
			status: 'pending',
			resource_type: 'org',
			permissions_json: JSON.stringify([
				'app:execute',
				'app:write',
				'app:delete',
				'app:create',
			]),
		})
		for (const grant of [
			{ id: 'grant-org', resource_type: 'org', preset: null },
			{ id: 'grant-app-preset', resource_type: 'app', preset: 'manage' },
			{ id: 'grant-app-advanced', resource_type: 'app', preset: null },
		]) {
			insert(db, 'grants', {
				...grant,
				resource_id: 'r',
				subject_type: 'user',
				subject_id: `user-${grant.id}`,
				origin: 'manual',
				deleted_at: null,
			})
			for (const permission of [
				'app:execute',
				'app:write',
				'app:delete',
				'app:create',
			]) {
				insert(db, 'grant_permissions', { grant_id: grant.id, permission })
			}
		}
	})

	expect(
		value(sqlite, `SELECT scopes_json FROM api_tokens WHERE id = 'token-full'`),
	).toBe(JSON.stringify(['job:read', 'package:read']))
	expect(
		value(
			sqlite,
			`SELECT scopes_json FROM api_tokens WHERE id = 'token-clean'`,
		),
	).toBe(JSON.stringify(['package:read', 'job:read']))
	expect(
		value(
			sqlite,
			`SELECT scopes_json FROM cli_credential_bootstrap_codes WHERE id = 'code-a'`,
		),
	).toBe(JSON.stringify(['org:execute']))
	expect(
		value(
			sqlite,
			`SELECT enabler_scopes_json FROM enablements WHERE id = 'enablement-a'`,
		),
	).toBe(JSON.stringify(['job:execute']))
	expect(
		value(
			sqlite,
			`SELECT permissions_json FROM invites WHERE id = 'invite-org'`,
		),
	).toBe(JSON.stringify(['app:execute']))
	expect(grantPermissions(sqlite, 'grant-org')).toEqual(['app:execute'])
	expect(grantPermissions(sqlite, 'grant-app-preset')).toEqual(['app:execute'])
	expect(grantPermissions(sqlite, 'grant-app-advanced')).toEqual([
		'app:delete',
		'app:execute',
		'app:write',
	])
})
