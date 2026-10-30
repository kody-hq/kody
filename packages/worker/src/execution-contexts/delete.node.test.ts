import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { formatRunRecord } from '#mcp/capabilities/runs/shared.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type ExecutionContextCaller, deleteContext } from './service.ts'

function setup(input: { userId?: string } = {}) {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insert = sqlite.prepare(
		`INSERT INTO execution_contexts (
			id, org_id, operator_user_id, name, public_key_jwk, thumbprint, created_at, revoked_at
		) VALUES (?, 'org_acme', 'user_cole', ?, '{}', ?, '2026-10-29', ?)`,
	)
	const revokedAt = new Date().toISOString()
	insert.run('ec_old', 'old-box', 'thumb_old', revokedAt)
	insert.run('ec_live', 'live-box', 'thumb_live', null)
	sqlite.exec(`
		INSERT INTO execution_context_opt_ins (context_id, user_id, org_id, created_at)
			VALUES ('ec_old', 'user_kent', 'org_acme', '2026-10-29'),
			       ('ec_live', 'user_kent', 'org_acme', '2026-10-29');
		INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, created_at)
			VALUES ('ec_old', 'org_team', 'user_cole', '2026-10-29');
		INSERT INTO execution_context_chains (org_id, user_id, strict, version, updated_at, updated_by_kind)
			VALUES ('org_acme', 'user_kent', 0, 3, '2026-10-29', 'user'),
			       ('org_acme', 'user_cole', 1, 1, '2026-10-29', 'user');
		INSERT INTO execution_context_chain_entries (org_id, user_id, position, context_id)
			VALUES ('org_acme', 'user_kent', 0, 'ec_old'),
			       ('org_acme', 'user_kent', 1, 'ec_live'),
			       ('org_acme', 'user_kent', 2, NULL),
			       ('org_acme', 'user_cole', 0, 'ec_old');
	`)
	const caller = {
		env: { APP_DB: createD1FromSqlite(sqlite) },
		callerContext: {},
		request: { actor: { username: 'cole' }, credential: { kind: 'session' } },
		userId: input.userId ?? 'user_cole',
		orgId: 'org_acme',
	} as unknown as ExecutionContextCaller
	const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n
	const chain = (userId: string) =>
		sqlite
			.prepare(
				`SELECT position, context_id FROM execution_context_chain_entries
				 WHERE org_id = 'org_acme' AND user_id = ? ORDER BY position`,
			)
			.all(userId)
	return { sqlite, caller, count, chain }
}

test('deleting a context that is not revoked is refused and changes nothing', async () => {
	const { caller, count } = setup()
	const attempt = deleteContext(caller, 'ec_live')
	await expect(attempt).rejects.toMatchObject({
		status: 409,
		code: 'context_not_revoked',
	})
	await expect(attempt).rejects.toThrow(
		'live-box is not revoked. Revoke it first',
	)
	expect(count(`SELECT COUNT(*) AS n FROM execution_contexts`)).toBe(2)
})

test('deleting needs Manage on the context', async () => {
	const { caller, count } = setup({ userId: 'user_kent' })
	await expect(deleteContext(caller, 'ec_old')).rejects.toMatchObject({
		status: 403,
		code: 'not_granted',
	})
	expect(
		count(`SELECT COUNT(*) AS n FROM execution_contexts WHERE id = 'ec_old'`),
	).toBe(1)
})

test('deleting a revoked context removes it and every dependent row', async () => {
	const { caller, count, chain } = setup()
	await expect(deleteContext(caller, 'old-box')).resolves.toEqual({
		deleted: true,
		id: 'ec_old',
		name: 'old-box',
	})
	for (const table of [
		'execution_contexts',
		'execution_context_opt_ins',
		'execution_context_org_attachments',
		'execution_context_chain_entries',
	]) {
		const column = table === 'execution_contexts' ? 'id' : 'context_id'
		expect(
			count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 'ec_old'`),
		).toBe(0)
	}
	expect(chain('user_kent')).toEqual([
		{ position: 0, context_id: 'ec_live' },
		{ position: 1, context_id: null },
	])
	expect(chain('user_cole')).toEqual([{ position: 0, context_id: null }])
	expect(
		count(
			`SELECT COUNT(*) AS n FROM execution_context_opt_ins WHERE context_id = 'ec_live'`,
		),
	).toBe(1)
	await expect(deleteContext(caller, 'ec_old')).rejects.toMatchObject({
		status: 404,
	})
})

test('a run that ran on a deleted context still renders its machine', () => {
	const run = {
		runId: 'run_1',
		surface: 'execute',
		status: 'succeeded',
		metadata: {
			executionContext: {
				id: 'ec_old',
				name: 'old-box',
				attempts: [{ id: 'ec_old', outcome: 'ran' }],
			},
		},
	} as unknown as RunRecord
	expect(formatRunRecord(run).metadata).toMatchObject({
		ranOn: { kind: 'context', id: 'ec_old', name: 'old-box' },
	})
})
