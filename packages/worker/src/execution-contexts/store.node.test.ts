import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { resolveExecutionContextRef } from './store.ts'

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insert = sqlite.prepare(
		`INSERT INTO execution_contexts (
			id, org_id, operator_user_id, name, public_key_jwk, thumbprint, created_at, revoked_at
		) VALUES (?, ?, 'user_cole', ?, '{}', ?, '2026-10-29', ?)`,
	)
	insert.run('ec_own', 'org_acme', 'shared-box', 'thumb_own', null)
	insert.run('ec_attached', 'org_other', 'shared-box', 'thumb_attached', null)
	insert.run(
		'ec_attached_only',
		'org_other',
		'attached-only',
		'thumb_only',
		null,
	)
	insert.run(
		'ec_revoked',
		'org_acme',
		'retired-box',
		'thumb_revoked',
		'2026-10-30',
	)
	sqlite.exec(`
		INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, created_at)
		VALUES ('ec_attached', 'org_acme', 'user_cole', '2026-10-29'),
		       ('ec_attached_only', 'org_acme', 'user_cole', '2026-10-29');
	`)
	return createD1FromSqlite(sqlite)
}

test('name refs use the visible live context without scanning revoked rows', async () => {
	const db = setup()
	await expect(
		resolveExecutionContextRef(db, 'org_acme', 'shared-box'),
	).resolves.toMatchObject({ id: 'ec_own' })
	await expect(
		resolveExecutionContextRef(db, 'org_acme', 'attached-only'),
	).resolves.toMatchObject({ id: 'ec_attached_only' })
	await expect(
		resolveExecutionContextRef(db, 'org_acme', 'retired-box'),
	).resolves.toBeNull()
})
