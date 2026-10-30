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
import { runMemoryPersonalizeCopy } from './memory-personalize.ts'
import { runMemoryPersonalizePurge } from './memory-personalize-purge.ts'
import * as memoryRepo from './repo.ts'
import { deleteMemoryVector } from './memory-vectorize.ts'

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
			deleted_at TEXT,
			vector_deleted_at TEXT,
			vector_cleanup_attempted_at TEXT
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

test('runMemoryPersonalizePurge blocks when a reader is missing a personal copy', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-block@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-block',
		email: 'ada-purge-block@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-block',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-block-co',
		displayName: 'Purge Block',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-block-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-block-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Keep me', 'No copy yet', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(result.blockedMissingCopy).toBe(1)
	expect(result.purged).toBe(0)
	expect(result.rows[0]?.outcome).toBe('blocked_missing_copy')
	expect(result.rows[0]?.provenanceUrisChecked).toEqual([
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	])
	const stillLive = await db
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`)
		.bind(memoryId, org!.id)
		.first<{ deleted_at: string | null }>()
	expect(stillLive?.deleted_at).toBeNull()
})

test('runMemoryPersonalizePurge soft-deletes only after copy, and revokes memory grants', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-ok@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-ok@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-ok',
		email: 'ada-purge-ok@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-ok',
		email: 'guest-purge-ok@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-ok',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-ok',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-ok-co',
		displayName: 'Purge Ok',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-ok-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-purge-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Ship Mondays', 'Prefer Monday ships', 'detail', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g-purge-1', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, memoryId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-purge-1', 'memory:read')`,
		)
		.run()

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()

	const copied = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(copied.copied).toBeGreaterThanOrEqual(2)
	expect(copied.warnings).toEqual([])

	const dry = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: true,
		orgIds: [org!.id],
	})
	expect(dry.blockedMissingCopy).toBe(0)
	expect(dry.wouldPurge).toBe(1)
	expect(dry.grantsWouldRevoke).toBe(1)
	expect(dry.rows[0]?.verifiedCopyCount).toBe(2)
	expect(dry.rows[0]?.provenanceUrisChecked[0]).toBe(
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	)

	const applied = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(applied.purged).toBe(1)
	expect(applied.grantsRevoked).toBe(1)
	expect(applied.blockedMissingCopy).toBe(0)

	const teamRow = await db
		.prepare(
			`SELECT status, deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
		)
		.bind(memoryId, org!.id)
		.first<{ status: string; deleted_at: string | null }>()
	expect(teamRow?.status).toBe('deleted')
	expect(teamRow?.deleted_at).toBeTruthy()

	const grant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'g-purge-1'`)
		.first<{ deleted_at: string | null }>()
	expect(grant?.deleted_at).toBeTruthy()

	const personalAda = personalOrgId(personIdFromStored(ada))
	const personalGuest = personalOrgId(personIdFromStored(guest))
	const adaCopy = await db
		.prepare(
			`SELECT deleted_at, source_uris_json FROM mcp_memories
			 WHERE user_id = ? AND source_uris_json LIKE ?`,
		)
		.bind(personalAda, `%${legacyOrgMemoryProvenanceUri(org!.id, memoryId)}%`)
		.first<{ deleted_at: string | null; source_uris_json: string }>()
	const guestCopy = await db
		.prepare(
			`SELECT deleted_at FROM mcp_memories
			 WHERE user_id = ? AND source_uris_json LIKE ?`,
		)
		.bind(personalGuest, `%${legacyOrgMemoryProvenanceUri(org!.id, memoryId)}%`)
		.first<{ deleted_at: string | null }>()
	expect(adaCopy?.deleted_at).toBeNull()
	expect(guestCopy?.deleted_at).toBeNull()
	expect(adaCopy?.source_uris_json).toContain(
		legacyOrgMemoryProvenanceUri(org!.id, memoryId),
	)

	const again = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(again.scannedMemories).toBe(0)
	expect(again.purged).toBe(0)
})

test('paged purge keeps grants for memories blocked on an earlier page', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-page@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-page@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-page',
		email: 'ada-purge-page@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-page',
		email: 'guest-purge-page@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-page',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-page',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-page-co',
		displayName: 'Purge Page',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-page-co'`)
		.first<{ id: string }>()
	const blockedId = 'mem-page-blocked'
	const purgeId = 'mem-page-purge'
	for (const [id, subject] of [
		[blockedId, 'Blocked'],
		[purgeId, 'Purge me'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO mcp_memories (
					id, user_id, status, subject, summary, details, created_at, updated_at
				) VALUES (?, ?, 'active', ?, 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, org!.id, subject)
		sqlite
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					created_by_user_id, created_at, updated_at
				) VALUES (?, ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(`g-${id}`, org!.id, id, guest, ada)
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, 'memory:read')`,
			)
			.run(`g-${id}`)
	}

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()

	// Copy only the purgeable memory so the blocked one stays missing a guest copy.
	const personalGuest = personalOrgId(personIdFromStored(guest))
	const personalAda = personalOrgId(personIdFromStored(ada))
	for (const personalOrg of [personalAda, personalGuest]) {
		sqlite
			.prepare(
				`INSERT INTO mcp_memories (
					id, user_id, status, subject, summary, details, source_uris_json,
					created_at, updated_at
				) VALUES (?, ?, 'active', 'Purge me', 'summary', '', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(
				`copy-${personalOrg}-${purgeId}`,
				personalOrg,
				JSON.stringify([legacyOrgMemoryProvenanceUri(org!.id, purgeId)]),
			)
	}

	const page1 = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
		memoryLimitPerOrg: 1,
	})
	expect(page1.blockedMissingCopy).toBe(1)
	expect(page1.rows[0]?.sourceMemoryId).toBe(blockedId)
	expect(page1.nextMemoryCursor).toBe(blockedId)
	expect(page1.grantsRevoked).toBe(0)

	const page2 = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
		orgCursor: page1.nextOrgCursor,
		memoryCursor: page1.nextMemoryCursor,
		memoryLimitPerOrg: 1,
	})
	expect(page2.purged).toBe(1)
	expect(page2.rows[0]?.sourceMemoryId).toBe(purgeId)
	expect(page2.nextMemoryCursor).toBeNull()
	expect(page2.grantsRevoked).toBe(1)
	expect(page2.grantRows.map((row) => row.resourceId)).toEqual([purgeId])

	const blockedGrant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = ?`)
		.bind(`g-${blockedId}`)
		.first<{ deleted_at: string | null }>()
	const purgedGrant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = ?`)
		.bind(`g-${purgeId}`)
		.first<{ deleted_at: string | null }>()
	expect(blockedGrant?.deleted_at).toBeNull()
	expect(purgedGrant?.deleted_at).toBeTruthy()

	const blockedStillLive = await db
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`)
		.bind(blockedId, org!.id)
		.first<{ deleted_at: string | null }>()
	expect(blockedStillLive?.deleted_at).toBeNull()
})

test('failed soft-delete leaves the live memory grant in place', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-fail-soft@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-fail-soft@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-fail-soft',
		email: 'ada-purge-fail-soft@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-fail-soft',
		email: 'guest-purge-fail-soft@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-fail-soft',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-fail-soft',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-fail-soft-co',
		displayName: 'Purge Fail Soft',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-fail-soft-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-fail-soft-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Keep grant', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g-fail-soft-1', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, memoryId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-fail-soft-1', 'memory:read')`,
		)
		.run()

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()

	const copied = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(copied.copied).toBeGreaterThanOrEqual(2)

	const updateSpy = vi
		.spyOn(memoryRepo, 'updateMemory')
		.mockResolvedValue(false)
	try {
		const result = await runMemoryPersonalizePurge({
			env,
			audit,
			dryRun: false,
			orgIds: [org!.id],
		})
		expect(result.purged).toBe(0)
		expect(result.grantsRevoked).toBe(0)
		expect(result.rows[0]?.outcome).toBe('soft_delete_failed')
		expect(
			result.warnings.some((warning) =>
				warning.includes(`Failed soft-deleting memory ${memoryId}`),
			),
		).toBe(true)
	} finally {
		updateSpy.mockRestore()
	}

	const stillLive = await db
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`)
		.bind(memoryId, org!.id)
		.first<{ deleted_at: string | null }>()
	expect(stillLive?.deleted_at).toBeNull()

	const grant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'g-fail-soft-1'`)
		.first<{ deleted_at: string | null }>()
	expect(grant?.deleted_at).toBeNull()
})

test('vector delete failure is surfaced, retried, and still counts the soft-delete', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-vec@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-vec@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-vec',
		email: 'ada-purge-vec@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-vec',
		email: 'guest-purge-vec@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-vec',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-vec',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-vec-co',
		displayName: 'Purge Vec',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-vec-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-purge-vec-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Vector fail', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g-purge-vec-1', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, memoryId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-purge-vec-1', 'memory:read')`,
		)
		.run()

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()

	const copied = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(copied.copied).toBeGreaterThanOrEqual(2)

	const deleteMock = vi.mocked(deleteMemoryVector)
	deleteMock.mockRejectedValue(new Error('vectorize unavailable'))
	try {
		const result = await runMemoryPersonalizePurge({
			env,
			audit,
			dryRun: false,
			orgIds: [org!.id],
		})
		expect(result.purged).toBe(1)
		expect(result.grantsRevoked).toBe(1)
		expect(result.vectorCleanupFailed).toBe(1)
		expect(
			result.warnings.some((warning) =>
				warning.includes('vector cleanup failed'),
			),
		).toBe(true)
		expect(
			result.warnings.some((warning) =>
				warning.includes('Vector cleanup still failing'),
			),
		).toBe(true)
		// softDelete retries once (2) + org reconciliation retry (1)
		expect(deleteMock.mock.calls.length).toBeGreaterThanOrEqual(3)
	} finally {
		deleteMock.mockReset()
		deleteMock.mockResolvedValue(undefined)
	}

	const teamRow = await db
		.prepare(
			`SELECT status, deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
		)
		.bind(memoryId, org!.id)
		.first<{ status: string; deleted_at: string | null }>()
	expect(teamRow?.status).toBe('deleted')
	expect(teamRow?.deleted_at).toBeTruthy()
})

test('later purge run retries stranded vector cleanup for soft-deleted rows', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-vec-retry@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-vec-retry',
		email: 'ada-purge-vec-retry@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-vec-retry',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-vec-retry-co',
		displayName: 'Purge Vec Retry',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-vec-retry-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-stranded-vec-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at
			) VALUES (?, ?, 'deleted', 'Already gone', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const deleteMock = vi.mocked(deleteMemoryVector)
	deleteMock.mockClear()
	deleteMock.mockResolvedValue(undefined)

	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(result.scannedMemories).toBe(0)
	expect(result.purged).toBe(0)
	expect(result.vectorCleanupFailed).toBe(0)
	expect(deleteMock).toHaveBeenCalledWith(env, memoryId)
	const marked = await db
		.prepare(
			`SELECT vector_deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
		)
		.bind(memoryId, org!.id)
		.first<{ vector_deleted_at: string | null }>()
	expect(marked?.vector_deleted_at).toBeTruthy()
})

test('paged org retries pending vectors before returning mid-org cursor', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-vec-page@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-vec-page@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-vec-page',
		email: 'ada-purge-vec-page@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-vec-page',
		email: 'guest-purge-vec-page@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-vec-page',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-vec-page',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-vec-page-co',
		displayName: 'Purge Vec Page',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-vec-page-co'`)
		.first<{ id: string }>()
	const firstId = 'mem-vec-page-1'
	const secondId = 'mem-vec-page-2'
	for (const [id, subject] of [
		[firstId, 'First'],
		[secondId, 'Second'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO mcp_memories (
					id, user_id, status, subject, summary, details, created_at, updated_at
				) VALUES (?, ?, 'active', ?, 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, org!.id, subject)
		sqlite
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					created_by_user_id, created_at, updated_at
				) VALUES (?, ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(`g-${id}`, org!.id, id, guest, ada)
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, 'memory:read')`,
			)
			.run(`g-${id}`)
	}

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()
	const personalAda = personalOrgId(personIdFromStored(ada))
	const personalGuest = personalOrgId(personIdFromStored(guest))
	for (const memoryId of [firstId, secondId]) {
		for (const personalOrg of [personalAda, personalGuest]) {
			sqlite
				.prepare(
					`INSERT INTO mcp_memories (
						id, user_id, status, subject, summary, details, source_uris_json,
						created_at, updated_at
					) VALUES (?, ?, 'active', 'copy', 'summary', '', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
				)
				.run(
					`copy-${personalOrg}-${memoryId}`,
					personalOrg,
					JSON.stringify([legacyOrgMemoryProvenanceUri(org!.id, memoryId)]),
				)
		}
	}

	const deleteMock = vi.mocked(deleteMemoryVector)
	deleteMock.mockRejectedValue(new Error('vectorize unavailable'))
	try {
		const page1 = await runMemoryPersonalizePurge({
			env,
			audit,
			dryRun: false,
			orgIds: [org!.id],
			memoryLimitPerOrg: 1,
		})
		expect(page1.purged).toBe(1)
		expect(page1.nextMemoryCursor).toBe(firstId)
		expect(page1.vectorCleanupFailed).toBe(1)
		expect(
			page1.warnings.some((warning) =>
				warning.includes('Vector cleanup still failing'),
			),
		).toBe(true)
		expect(deleteMock.mock.calls.length).toBeGreaterThanOrEqual(3)
		const pending = await db
			.prepare(
				`SELECT vector_deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
			)
			.bind(firstId, org!.id)
			.first<{ vector_deleted_at: string | null }>()
		expect(pending?.vector_deleted_at).toBeNull()
	} finally {
		deleteMock.mockReset()
		deleteMock.mockResolvedValue(undefined)
	}
})

test('vector retry prefers older pending rows and skips already-cleaned ones', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-vec-old@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-vec-old',
		email: 'ada-purge-vec-old@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-vec-old',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-vec-old-co',
		displayName: 'Purge Vec Old',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-vec-old-co'`)
		.first<{ id: string }>()
	const olderId = 'mem-stranded-old'
	const newerCleanId = 'mem-stranded-new-clean'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at, vector_deleted_at
			) VALUES (?, ?, 'deleted', 'Older stranded', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
		)
		.run(olderId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at, vector_deleted_at
			) VALUES (?, ?, 'deleted', 'Newer clean', 'summary', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`,
		)
		.run(newerCleanId, org!.id)

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const deleteMock = vi.mocked(deleteMemoryVector)
	deleteMock.mockClear()
	deleteMock.mockResolvedValue(undefined)

	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
		memoryLimitPerOrg: 1,
	})
	expect(result.vectorCleanupFailed).toBe(0)
	expect(deleteMock).toHaveBeenCalledWith(env, olderId)
	expect(deleteMock).not.toHaveBeenCalledWith(env, newerCleanId)
	const olderMarked = await db
		.prepare(
			`SELECT vector_deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
		)
		.bind(olderId, org!.id)
		.first<{ vector_deleted_at: string | null }>()
	expect(olderMarked?.vector_deleted_at).toBeTruthy()
})

test('failed vector attempts rotate so newer pending rows are reached', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-vec-rotate@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-vec-rotate',
		email: 'ada-purge-vec-rotate@example.com',
		personId: ada,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-vec-rotate',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-vec-rotate-co',
		displayName: 'Purge Vec Rotate',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-vec-rotate-co'`)
		.first<{ id: string }>()
	const stickyFailId = 'mem-sticky-fail'
	const neverAttemptedId = 'mem-never-attempted'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at, vector_deleted_at, vector_cleanup_attempted_at
			) VALUES (?, ?, 'deleted', 'Sticky', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, '2026-01-04T00:00:00.000Z')`,
		)
		.run(stickyFailId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at, vector_deleted_at, vector_cleanup_attempted_at
			) VALUES (?, ?, 'deleted', 'Fresh', 'summary', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL, NULL)`,
		)
		.run(neverAttemptedId, org!.id)

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const deleteMock = vi.mocked(deleteMemoryVector)
	deleteMock.mockClear()
	deleteMock.mockImplementation(async (_env, memoryId) => {
		if (memoryId === stickyFailId) {
			throw new Error('vectorize permanently unavailable')
		}
	})

	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
		memoryLimitPerOrg: 1,
	})
	expect(deleteMock).toHaveBeenCalledWith(env, neverAttemptedId)
	expect(deleteMock).not.toHaveBeenCalledWith(env, stickyFailId)
	expect(result.vectorCleanupFailed).toBe(0)
	const freshMarked = await db
		.prepare(
			`SELECT vector_deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`,
		)
		.bind(neverAttemptedId, org!.id)
		.first<{ vector_deleted_at: string | null }>()
	expect(freshMarked?.vector_deleted_at).toBeTruthy()
})

test('mid-org page retries only this invocation pending vectors', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-vec-mid@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-vec-mid@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-vec-mid',
		email: 'ada-purge-vec-mid@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-vec-mid',
		email: 'guest-purge-vec-mid@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-vec-mid',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-vec-mid',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-vec-mid-co',
		displayName: 'Purge Vec Mid',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-vec-mid-co'`)
		.first<{ id: string }>()
	const strandedId = 'mem-mid-stranded'
	const liveId = 'mem-mid-a'
	const extraLiveId = 'mem-mid-b'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at, vector_deleted_at
			) VALUES (?, ?, 'deleted', 'Stranded', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
		)
		.run(strandedId, org!.id)
	for (const [id, subject] of [
		[liveId, 'Live'],
		[extraLiveId, 'Extra'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO mcp_memories (
					id, user_id, status, subject, summary, details, created_at, updated_at
				) VALUES (?, ?, 'active', ?, 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, org!.id, subject)
		sqlite
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					created_by_user_id, created_at, updated_at
				) VALUES (?, ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(`g-${id}`, org!.id, id, guest, ada)
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, 'memory:read')`,
			)
			.run(`g-${id}`)
	}
	const personalAda = personalOrgId(personIdFromStored(ada))
	const personalGuest = personalOrgId(personIdFromStored(guest))
	for (const memoryId of [liveId, extraLiveId]) {
		for (const personalOrg of [personalAda, personalGuest]) {
			sqlite
				.prepare(
					`INSERT INTO mcp_memories (
						id, user_id, status, subject, summary, details, source_uris_json,
						created_at, updated_at
					) VALUES (?, ?, 'active', 'copy', 'summary', '', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
				)
				.run(
					`copy-${personalOrg}-${memoryId}`,
					personalOrg,
					JSON.stringify([legacyOrgMemoryProvenanceUri(org!.id, memoryId)]),
				)
		}
	}

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const deleteMock = vi.mocked(deleteMemoryVector)
	deleteMock.mockClear()
	deleteMock.mockRejectedValue(new Error('vectorize unavailable'))
	try {
		const page1 = await runMemoryPersonalizePurge({
			env,
			audit: createTestOrgAuditWriter(),
			dryRun: false,
			orgIds: [org!.id],
			memoryLimitPerOrg: 1,
		})
		expect(page1.purged).toBe(1)
		expect(page1.nextMemoryCursor).toBe(liveId)
		expect(page1.vectorCleanupFailed).toBe(1)
		const calledIds = deleteMock.mock.calls.map((call) => call[1])
		expect(calledIds).toContain(liveId)
		expect(calledIds).not.toContain(strandedId)
	} finally {
		deleteMock.mockReset()
		deleteMock.mockResolvedValue(undefined)
	}
})

test('soft_delete_failed is distinct from already_gone when the live row remains', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-outcome@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-outcome@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-outcome',
		email: 'ada-purge-outcome@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-outcome',
		email: 'guest-purge-outcome@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-outcome',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-outcome',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-outcome-co',
		displayName: 'Purge Outcome',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-outcome-co'`)
		.first<{ id: string }>()
	const memoryId = 'mem-outcome-1'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Keep me', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(memoryId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g-outcome-1', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, memoryId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-outcome-1', 'memory:read')`,
		)
		.run()

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const copied = await runMemoryPersonalizeCopy({
		env,
		dryRun: false,
		orgIds: [org!.id],
	})
	expect(copied.copied).toBeGreaterThanOrEqual(2)

	const updateSpy = vi
		.spyOn(memoryRepo, 'updateMemory')
		.mockResolvedValue(false)
	try {
		const result = await runMemoryPersonalizePurge({
			env,
			audit: createTestOrgAuditWriter(),
			dryRun: false,
			orgIds: [org!.id],
		})
		expect(result.rows.map((row) => row.outcome)).toEqual([
			'soft_delete_failed',
		])
		expect(result.rows.some((row) => row.outcome === 'already_gone')).toBe(
			false,
		)
		expect(result.grantsRevoked).toBe(0)
	} finally {
		updateSpy.mockRestore()
	}
})

test('multi-page dry-run grant revoke counts match a real paged run', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-dry-page@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-dry-page@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-dry-page',
		email: 'ada-purge-dry-page@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-dry-page',
		email: 'guest-purge-dry-page@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-dry-page',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-dry-page',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-dry-page-co',
		displayName: 'Purge Dry Page',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-dry-page-co'`)
		.first<{ id: string }>()
	const firstId = 'mem-dry-page-1'
	const secondId = 'mem-dry-page-2'
	for (const [id, subject] of [
		[firstId, 'First'],
		[secondId, 'Second'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO mcp_memories (
					id, user_id, status, subject, summary, details, created_at, updated_at
				) VALUES (?, ?, 'active', ?, 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, org!.id, subject)
		sqlite
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					created_by_user_id, created_at, updated_at
				) VALUES (?, ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(`g-${id}`, org!.id, id, guest, ada)
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, 'memory:read')`,
			)
			.run(`g-${id}`)
	}

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()
	const personalAda = personalOrgId(personIdFromStored(ada))
	const personalGuest = personalOrgId(personIdFromStored(guest))
	for (const memoryId of [firstId, secondId]) {
		for (const personalOrg of [personalAda, personalGuest]) {
			sqlite
				.prepare(
					`INSERT INTO mcp_memories (
						id, user_id, status, subject, summary, details, source_uris_json,
						created_at, updated_at
					) VALUES (?, ?, 'active', 'copy', 'summary', '', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
				)
				.run(
					`copy-${personalOrg}-${memoryId}`,
					personalOrg,
					JSON.stringify([legacyOrgMemoryProvenanceUri(org!.id, memoryId)]),
				)
		}
	}

	const dryPage1 = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: true,
		orgIds: [org!.id],
		memoryLimitPerOrg: 1,
	})
	expect(dryPage1.wouldPurge).toBe(1)
	expect(dryPage1.grantsWouldRevoke).toBe(0)
	expect(dryPage1.nextMemoryCursor).toBe(firstId)
	expect(dryPage1.nextPlannedPurgeMemoryIds).toEqual([firstId])

	const dryPage2 = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: true,
		orgIds: [org!.id],
		orgCursor: dryPage1.nextOrgCursor,
		memoryCursor: dryPage1.nextMemoryCursor,
		plannedPurgeMemoryIds: dryPage1.nextPlannedPurgeMemoryIds,
		memoryLimitPerOrg: 1,
	})
	expect(dryPage2.wouldPurge).toBe(1)
	expect(dryPage2.nextMemoryCursor).toBeNull()
	expect(dryPage2.nextPlannedPurgeMemoryIds).toEqual([])
	expect(dryPage2.grantsWouldRevoke).toBe(2)
	expect(dryPage2.grantRows.map((row) => row.resourceId).sort()).toEqual(
		[firstId, secondId].sort(),
	)

	const dryGrantsWouldRevoke =
		dryPage1.grantsWouldRevoke + dryPage2.grantsWouldRevoke

	const realPage1 = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
		memoryLimitPerOrg: 1,
	})
	expect(realPage1.purged).toBe(1)
	expect(realPage1.grantsRevoked).toBe(0)

	const realPage2 = await runMemoryPersonalizePurge({
		env,
		audit,
		dryRun: false,
		orgIds: [org!.id],
		orgCursor: realPage1.nextOrgCursor,
		memoryCursor: realPage1.nextMemoryCursor,
		memoryLimitPerOrg: 1,
	})
	expect(realPage2.purged).toBe(1)
	expect(realPage2.grantsRevoked).toBe(2)
	expect(realPage2.grantRows.map((row) => row.resourceId).sort()).toEqual(
		[firstId, secondId].sort(),
	)

	expect(dryGrantsWouldRevoke).toBe(
		realPage1.grantsRevoked + realPage2.grantsRevoked,
	)
	expect(dryPage1.wouldPurge + dryPage2.wouldPurge).toBe(
		realPage1.purged + realPage2.purged,
	)
})

test('applied purge ignores plannedPurgeMemoryIds so live grants stay', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-planned-ignore@example.com')
	const guest = testStableUserIdFromEmail(
		'guest-purge-planned-ignore@example.com',
	)
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-planned-ignore',
		email: 'ada-purge-planned-ignore@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-planned-ignore',
		email: 'guest-purge-planned-ignore@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-planned-ignore',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-planned-ignore',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-planned-ignore-co',
		displayName: 'Purge Planned Ignore',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-planned-ignore-co'`)
		.first<{ id: string }>()
	const liveId = 'mem-planned-live'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Still live', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(liveId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				created_by_user_id, created_at, updated_at
			) VALUES ('g-planned-live', ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(org!.id, liveId, guest, ada)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-planned-live', 'memory:read')`,
		)
		.run()

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
		plannedPurgeMemoryIds: [liveId],
		purgeOrphans: false,
	})
	expect(result.purged).toBe(0)
	expect(result.grantsRevoked).toBe(0)
	const grant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'g-planned-live'`)
		.first<{ deleted_at: string | null }>()
	expect(grant?.deleted_at).toBeNull()
	const stillLive = await db
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = ? AND user_id = ?`)
		.bind(liveId, org!.id)
		.first<{ deleted_at: string | null }>()
	expect(stillLive?.deleted_at).toBeNull()
})

test('grant sweep batches live memory lookups and only revokes non-live grants', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada-purge-batch-live@example.com')
	const guest = testStableUserIdFromEmail('guest-purge-batch-live@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada-purge-batch-live',
		email: 'ada-purge-batch-live@example.com',
		personId: ada,
	})
	insertUser(sqlite, {
		id: 2,
		username: 'guest-purge-batch-live',
		email: 'guest-purge-batch-live@example.com',
		personId: guest,
	})
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada-purge-batch-live',
	})
	await provisionPersonalOrg(db, {
		stableUserId: guest,
		username: 'guest-purge-batch-live',
	})
	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'purge-batch-live-co',
		displayName: 'Purge Batch Live',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'purge-batch-live-co'`)
		.first<{ id: string }>()
	const liveId = 'mem-batch-live'
	const goneId = 'mem-batch-gone'
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, 'active', 'Live', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(liveId, org!.id)
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at,
				deleted_at, vector_deleted_at
			) VALUES (?, ?, 'deleted', 'Gone', 'summary', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.run(goneId, org!.id)
	for (const [grantId, memoryId] of [
		['g-batch-live', liveId],
		['g-batch-gone', goneId],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					created_by_user_id, created_at, updated_at
				) VALUES (?, ?, 'memory', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(grantId, org!.id, memoryId, guest, ada)
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, 'memory:read')`,
			)
			.run(grantId)
	}

	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
	} as unknown as Env
	const result = await runMemoryPersonalizePurge({
		env,
		audit: createTestOrgAuditWriter(),
		dryRun: false,
		orgIds: [org!.id],
		purgeOrphans: false,
	})
	expect(result.grantsRevoked).toBe(1)
	expect(result.grantRows.map((row) => row.resourceId)).toEqual([goneId])
	const liveGrant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'g-batch-live'`)
		.first<{ deleted_at: string | null }>()
	const goneGrant = await db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'g-batch-gone'`)
		.first<{ deleted_at: string | null }>()
	expect(liveGrant?.deleted_at).toBeNull()
	expect(goneGrant?.deleted_at).toBeTruthy()
})
