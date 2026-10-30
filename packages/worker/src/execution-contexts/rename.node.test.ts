import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type ExecutionContextCaller, updateContext } from './service.ts'

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insert = sqlite.prepare(
		`INSERT INTO execution_contexts (
			id, org_id, operator_user_id, name, public_key_jwk, thumbprint, created_at, revoked_at
		) VALUES (?, 'org_acme', 'user_cole', ?, '{}', ?, '2026-10-29', ?)`,
	)
	insert.run('ec_revoked', 'coles-computer', 'thumb_revoked', '2026-10-29')
	insert.run('ec_live', 'coles-computer-2', 'thumb_live', null)
	insert.run('ec_laptop', 'laptop', 'thumb_laptop', null)
	const caller = {
		env: { APP_DB: createD1FromSqlite(sqlite) },
		callerContext: {},
		request: { actor: { username: 'cole' } },
		userId: 'user_cole',
		orgId: 'org_acme',
	} as unknown as ExecutionContextCaller
	const nameOf = (id: string) =>
		(
			sqlite
				.prepare(`SELECT name FROM execution_contexts WHERE id = ?`)
				.get(id) as { name: string }
		).name
	return { caller, nameOf }
}

test('renaming to a revoked context name takes the released name', async () => {
	const { caller, nameOf } = setup()
	await updateContext(caller, 'ec_live', { name: 'coles-computer' })
	expect(nameOf('ec_live')).toBe('coles-computer')
	expect(nameOf('ec_revoked')).toBe('coles-computer')
})

test('renaming to a live context name is a plain invalid_request', async () => {
	const { caller, nameOf } = setup()
	const rename = updateContext(caller, 'ec_live', { name: 'laptop' })
	await expect(rename).rejects.toMatchObject({
		status: 409,
		code: 'invalid_request',
	})
	await expect(rename).rejects.toThrow(
		'Another context in this org is already named laptop. Pick another name.',
	)
	expect(nameOf('ec_live')).toBe('coles-computer-2')
})
