import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { loadPackageSecurityAuditState } from './security-audit-state.ts'
import { insertPackageSecurityAudit } from './security-audits-repo.ts'

const publishedCommit = '34f338c19f91c698c3a28edd2992e0ab87dcb4e0'
const fingerprint = 'fp-current'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE saved_packages (id TEXT PRIMARY KEY NOT NULL);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT,
			username TEXT,
			deleted_at TEXT
		);
		INSERT INTO saved_packages (id) VALUES ('pkg-1');
		INSERT INTO users (id, stable_user_id, username) VALUES (1, 'person-1', 'kody');
	`)
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0146-package-security-audits.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return createD1FromSqlite(sqlite)
}

function loadState(
	db: D1Database,
	version: { publishedCommit: string | null; fingerprint: string },
) {
	return loadPackageSecurityAuditState({
		db,
		ownerUserId: 'owner-1',
		packageId: 'pkg-1',
		packageName: '@kody/mau-chart',
		approvalUrl: 'https://kody.codes/@kody/mau-chart/approve-capabilities',
		...version,
	})
}

async function recordAudit(
	db: D1Database,
	overrides: { auditorLabel?: string | null; recordedByUserId?: string } = {},
) {
	await insertPackageSecurityAudit(db, {
		id: crypto.randomUUID(),
		packageId: 'pkg-1',
		ownerUserId: 'owner-1',
		publishedCommit,
		fingerprint,
		verdict: 'pass',
		summary: 'Nothing concerning.',
		auditorLabel: 'Audit Agent',
		recordedByUserId: 'person-1',
		recordedAt: '2026-10-14T15:30:00.000Z',
		...overrides,
	})
}

test('an audit counts only for the exact published commit and capability fingerprint', async () => {
	const db = createDb()
	await recordAudit(db)

	await expect(
		loadState(db, { publishedCommit, fingerprint }),
	).resolves.toEqual({
		status: 'audited',
		verdict: 'pass',
		summary: 'Nothing concerning.',
		auditor: 'Audit Agent',
		recordedBy: '@kody',
		recordedAt: '2026-10-14T15:30:00.000Z',
	})

	const newPublish = await loadState(db, {
		publishedCommit: 'ffffffffffffffffffffffffffffffffffffffff',
		fingerprint,
	})
	expect(newPublish.status).toBe('not_audited')

	const changedCapabilities = await loadState(db, {
		publishedCommit,
		fingerprint: 'fp-changed',
	})
	expect(changedCapabilities).toMatchObject({
		status: 'not_audited',
		prompt: expect.stringContaining('capability fingerprint: fp-changed'),
	})
})

test('an unnamed auditor is credited to the recorder, and unpublished packages cannot be audited', async () => {
	const db = createDb()
	await recordAudit(db, { auditorLabel: null })

	await expect(
		loadState(db, { publishedCommit, fingerprint }),
	).resolves.toMatchObject({ auditor: '@kody', recordedBy: null })

	await expect(
		loadState(db, { publishedCommit: null, fingerprint }),
	).resolves.toEqual({ status: 'unpublished' })
})
