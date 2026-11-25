import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { localD1HasUsersTable, runDoctor } from './control-kody.ts'

function persistWithD1(tables: Array<string>) {
	const persistRoot = mkdtempSync(path.join(tmpdir(), 'kody-doctor-'))
	const d1Dir = path.join(persistRoot, 'v3', 'd1', 'miniflare-D1DatabaseObject')
	mkdirSync(d1Dir, { recursive: true })
	const db = new DatabaseSync(path.join(d1Dir, 'app.sqlite'))
	for (const table of tables) db.exec(`CREATE TABLE ${table} (id TEXT)`)
	db.close()
	return persistRoot
}

async function localD1Check(persistRoot: string) {
	const report = await runDoctor({
		nodeVersion: 'v26.0.0',
		homeDir: persistRoot,
		hooksPath: '.husky',
		inspectPlaywright: () => ({ ok: true, detail: 'ok' }),
		inspectInstalledLockfile: () => ({ ok: true, detail: 'ok' }),
		probeHealth: async () => false,
		ports: [],
		origin: null,
		persistRoot,
		hasLocalUsersTable: localD1HasUsersTable,
	})
	return report.checks.find((check) => check.name === 'local-d1')
}

test('doctor fails local-d1 when the persisted D1 has no users table', async () => {
	const check = await localD1Check(persistWithD1(['d1_migrations']))
	expect(check?.ok).toBe(false)
	expect(check?.detail).toContain('no readable users table')
})

test('doctor passes local-d1 when a persisted D1 has the users table', async () => {
	const check = await localD1Check(persistWithD1(['users']))
	expect(check?.ok).toBe(true)
	expect(check?.detail).toContain('local persist present')
})

test('localD1HasUsersTable is false when the persist has no D1 files', () => {
	expect(
		localD1HasUsersTable(mkdtempSync(path.join(tmpdir(), 'kody-doctor-'))),
	).toBe(false)
})
