import { DatabaseSync } from 'node:sqlite'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createInMemoryUserMeterEnv,
	createPermissiveAccountWriteLeaseDbHooks,
} from '#worker/test-support/user-meter.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { legacyOrgMemoryProvenanceUri } from './memory-owner.ts'
import {
	listMemoryReadersForOrgMemory,
	runMemoryPersonalizeCopy,
} from './memory-personalize.ts'

vi.mock('#worker/entitlements/service.ts', () => ({
	assertWithinStorageBytesEntitlement: vi.fn(async () => undefined),
	estimateEntitlementStorageEntryByteDelta: () => 1,
}))

vi.mock('./memory-vectorize.ts', () => ({
	upsertMemoryVector: vi.fn(async () => undefined),
	deleteMemoryVector: vi.fn(async () => undefined),
}))

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	const writeLease = createPermissiveAccountWriteLeaseDbHooks()
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		if (writeLease.supportsDeletingAtQuery(query)) {
			return {
				bind: () => ({
					first: async () => writeLease.deletingAtFirstResult(),
					all: async () => ({ results: [] }),
					run: async () => ({ meta: { changes: 0 } }),
				}),
			}
		}
		return originalPrepare(query)
	}) as typeof db.prepare
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS mcp_memories (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			category TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			subject TEXT NOT NULL,
			summary TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT '',
			tags_json TEXT NOT NULL DEFAULT '[]',
			source_uris_json TEXT NOT NULL DEFAULT '[]',
			dedupe_key TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_accessed_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE IF NOT EXISTS grants (
			id TEXT PRIMARY KEY NOT NULL,
			org_id TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL,
			preset TEXT,
			created_by_user_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			deleted_at TEXT, expires_at TEXT
		);
		CREATE TABLE IF NOT EXISTS grant_permissions (
			grant_id TEXT NOT NULL,
			permission TEXT NOT NULL,
			PRIMARY KEY (grant_id, permission)
		);
	`)
	return { db, sqlite }
}

function insertUser(
	sqlite: DatabaseSync,
	input: { id: number; username: string; email: string; personId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (?, ?, ?, 'x', ?)`,
		)
		.run(input.id, input.username, input.email, input.personId)
}

test('listMemoryReadersForOrgMemory includes owners and memory grant subjects', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const bob = testStableUserIdFromEmail('bob@example.com')
	const guest = testStableUserIdFromEmail('guest@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada',
		email: 'ada@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'bob',
		email: 'bob@example.com',
		personId: bob,
	})
	insertUser(sqlite, {
		id: 3,
		username: 'guest',
		email: 'guest@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada' })
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'zeta-memory-co',
		displayName: 'Zeta Memory Co',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-memory-co'`)
		.first<{ id: string }>()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(org!.id, bob)
		.run()
	const memoryId = 'mem-team-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Deploy day', 'Friday deploys', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g1', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, memoryId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g1', 'memory:read')`,
		)
		.run()

	const readers = await listMemoryReadersForOrgMemory({
		db,
		orgId: org!.id,
		memoryId,
	})
	expect(new Set(readers)).toEqual(
		new Set([personIdFromStored(ada), personIdFromStored(guest)]),
	)
	expect(readers).not.toContain(personIdFromStored(bob))
})

test('runMemoryPersonalizeCopy copies to readers, skips content duplicates, and is idempotent via provenance', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-copy@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-copy',
		email: 'ada-copy@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada-copy' })
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'beta-co',
		displayName: 'Beta',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'beta-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-copy-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Ship Fridays', 'Prefer Friday ships', 'detail', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const dry = await runMemoryPersonalizeCopy({
		env,
		dryRun: true,
		orgIds: [org!.id],
	})
	expect(dry.wouldCopy).toBe(1)
	expect(dry.copied).toBe(0)

	const applied = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(applied.warnings).toEqual([])
	expect(applied.copied).toBe(1)
	const personalId = personalOrgId(personIdFromStored(ada))
	const copied = await db
		.prepare(
			`SELECT id, subject, source_uris_json FROM mcp_memories
			 WHERE user_id = ? AND id != ?`,
		)
		.bind(personalId, memoryId)
		.first<{ id: string; subject: string; source_uris_json: string }>()
	expect(copied?.subject).toBe('Ship Fridays')
	expect(copied?.source_uris_json).toContain(
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	)
	const original = await db
		.prepare(`SELECT user_id FROM mcp_memories WHERE id = ?`)
		.bind(memoryId)
		.first<{ user_id: string }>()
	expect(original?.user_id).toBe(org!.id)

	const again = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(again.skippedAlreadyCopied).toBe(1)
	expect(again.copied).toBe(0)

	const dupMemoryId = 'mem-copy-2'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Already mine', 'Same fact', 'same details', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(dupMemoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Already mine', 'Same fact', 'same details', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run('mem-personal-dup', personalId)
	const dup = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(dup.skippedContentDuplicate).toBeGreaterThanOrEqual(1)
	expect(
		dup.rows.some(
			(row) =>
				row.sourceMemoryId === dupMemoryId &&
				row.outcome === 'skipped_content_duplicate',
		),
	).toBe(true)
})

test('runMemoryPersonalizeCopy resumes an org via memoryCursor when memoryLimitPerOrg caps mid-org', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-page@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-page',
		email: 'ada-page@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada-page' })
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'page-co',
		displayName: 'Page Co',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'page-co'`)
		.first<{ id: string }>()
	for (let i = 0; i < 5; i++) {
		const id = `mem-page-${String(i).padStart(2, '0')}`
		sqlite
			.prepare(
				`INSERT INTO mcp_memories (
					id, user_id, status, subject, summary, details, created_at, updated_at
				) VALUES (?, ?, 'active', ?, ?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, org!.id, `Subject ${i}`, `Summary ${i}`)
	}
	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env

	const first = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
		memoryLimitPerOrg: 2,
	})
	expect(first.scannedMemories).toBe(2)
	expect(first.copied).toBe(2)
	expect(first.nextMemoryCursor).toBeTruthy()
	expect(first.nextOrgCursor).toBeNull()
	expect(first.warnings.some((w) => w.includes('more memories'))).toBe(true)

	const second = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
		orgCursor: first.nextOrgCursor,
		memoryCursor: first.nextMemoryCursor,
		memoryLimitPerOrg: 2,
	})
	expect(second.scannedMemories).toBe(2)
	expect(second.copied).toBe(2)
	expect(second.nextMemoryCursor).toBeTruthy()

	const third = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
		orgCursor: second.nextOrgCursor,
		memoryCursor: second.nextMemoryCursor,
		memoryLimitPerOrg: 2,
	})
	expect(third.scannedMemories).toBe(1)
	expect(third.copied).toBe(1)
	expect(third.nextMemoryCursor).toBeNull()
	expect(third.nextOrgCursor).toBeNull()

	const personalId = personalOrgId(personIdFromStored(ada))
	const { results: personalRows } = await db
		.prepare(`SELECT source_uris_json FROM mcp_memories WHERE user_id = ?`)
		.bind(personalId)
		.all<{ source_uris_json: string }>()
	const provenancePrefix = `https://kody.codes/legacy-org-memory/${org!.id}/mem-page-`
	const copiedFromTeam = (personalRows ?? []).filter((row) =>
		row.source_uris_json.includes(provenancePrefix),
	)
	expect(copiedFromTeam.length).toBe(5)
})
