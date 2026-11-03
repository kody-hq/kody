import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { applyAllMigrations } from './apply-all-migrations.ts'
import { createD1FromSqlite } from './create-d1-from-sqlite.ts'

function createAppTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

/** In-memory AUDIT_DB with every audit migration applied. */
export function createAuditTestDb() {
	const dir = new URL('../../audit-migrations/', import.meta.url)
	const sqlite = new DatabaseSync(':memory:')
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith('.sql')) continue
		sqlite.exec(readFileSync(new URL(file, dir), 'utf8'))
	}
	return createD1FromSqlite(sqlite)
}

/** Org audit writer for tests that call write helpers directly. */
export function createTestOrgAuditWriter(input?: {
	db?: D1Database
	appDb?: D1Database
	actorUserId?: string | null
}): OrgAuditWriter {
	return {
		appDb: input?.appDb ?? createAppTestDb(),
		db: input?.db ?? createAuditTestDb(),
		actorUserId: input?.actorUserId ?? null,
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
	}
}
