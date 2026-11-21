import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const busySources = new Set<string>()
const hasActiveRepoSessionForSource = vi.fn(
	async (_env: unknown, input: { userId: string; sourceId: string }) =>
		busySources.has(input.sourceId),
)
vi.mock('#worker/repo/repo-sessions.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	hasActiveRepoSessionForSource: (env: unknown, input: never) =>
		hasActiveRepoSessionForSource(env, input),
}))

const deleteUserAccount = vi.fn()
vi.mock('#app/account-deletion.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	deleteUserAccount: (input: unknown) => deleteUserAccount(input),
}))
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent: () => {},
}))

let auditGate: Promise<void> | null = null
let auditSettled = 0
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<object>()
	return {
		...actual,
		logAuditEvent: async (event: { action: string }) => {
			if (auditGate) await auditGate
			auditSettled += 1
			return { persisted: true, failedSinks: [], event: event.action }
		},
	}
})

const finishLegacyUserDeletion = vi.fn()
vi.mock('#worker/orgs/hard-purge.ts', () => ({
	hardPurgeOrg: vi.fn(),
	hardPurgeSoftDeletedUser: vi.fn(),
	finishLegacyUserDeletion: (input: unknown) => finishLegacyUserDeletion(input),
}))

const { pruneExpiredGuestAccounts } =
	await import('#worker/guest/guest-account-purge.ts')
const { pruneSoftDeleted } = await import('#worker/orgs/purge.ts')
const { pruneRetention } = await import('#app/retention.ts')
const { OAuthPurgeCoordinator } = await import('#worker/oauth-purge.ts')

beforeEach(() => {
	busySources.clear()
	hasActiveRepoSessionForSource.mockClear()
	deleteUserAccount.mockReset()
	finishLegacyUserDeletion.mockReset()
	auditGate = null
	auditSettled = 0
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	consoleInfo.mockImplementation(() => {})
})

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createAuditDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../audit-migrations/', import.meta.url),
	)
	return createD1FromSqlite(sqlite)
}

const failingAuditDb = {
	prepare() {
		throw new Error('AUDIT_DB unavailable')
	},
	batch() {
		throw new Error('AUDIT_DB unavailable')
	},
} as unknown as D1Database

async function seedUser(
	db: D1Database,
	input: {
		id: number
		stableUserId: string
		deletingAt?: string | null
		deletedAt?: string | null
		guestExpiresAt?: string | null
	},
) {
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id,
				created_at, updated_at, deleting_at, deleted_at, guest_expires_at
			) VALUES (?, ?, ?, 'hash', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.stableUserId,
			`${input.stableUserId}@example.com`,
			input.stableUserId,
			ts,
			ts,
			input.deletingAt ?? null,
			input.deletedAt ?? null,
			input.guestExpiresAt ?? null,
		)
		.run()
}

async function seedGuest(db: D1Database, personId: string, deleteAt: string) {
	await seedUser(db, {
		id: Number(personId.replace(/\D/g, '')),
		stableUserId: personId,
		guestExpiresAt: deleteAt,
	})
	await db
		.prepare(
			`INSERT INTO guest_accounts (person_id, personal_org_id, claim_code, expires_at, delete_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			personId,
			personId,
			`code-${personId}`,
			deleteAt,
			deleteAt,
			'2026-01-01T00:00:00.000Z',
		)
		.run()
}

const guestNow = new Date('2026-10-01T12:00:00.000Z')

test('guest purge awaits its guest_account_purged audit write before returning', async () => {
	const { db } = createAppDb()
	await seedGuest(db, 'guest1', '2026-09-01T00:00:00.000Z')
	deleteUserAccount.mockResolvedValue(undefined)
	let release!: () => void
	auditGate = new Promise((resolve) => {
		release = resolve
	})
	const env = { APP_DB: db, AUDIT_DB: createAuditDb() } as unknown as Env
	const result = await pruneExpiredGuestAccounts({ env, now: guestNow })
	expect(result.purged).toBe(1)
	const settledAtReturn = auditSettled
	release()
	await Promise.resolve()
	expect(settledAtReturn).toBe(1)
})

test('guest purge retries a guest whose account deletion failed after the deletion fence was set', async () => {
	const { db } = createAppDb()
	await seedGuest(db, 'guest2', '2026-09-01T00:00:00.000Z')
	// Real deleteUserAccount leaves users.deleting_at set when out-of-band
	// cleanup fails after markAccountDeleting (only inventory/billing/lease
	// failures abort the fence).
	deleteUserAccount.mockImplementationOnce(async () => {
		await db
			.prepare(
				`UPDATE users SET deleting_at = ? WHERE stable_user_id = 'guest2'`,
			)
			.bind(guestNow.toISOString())
			.run()
		throw new Error('account_deletion_cleanup_incomplete')
	})
	deleteUserAccount.mockResolvedValue(undefined)
	const env = { APP_DB: db, AUDIT_DB: createAuditDb() } as unknown as Env
	const first = await pruneExpiredGuestAccounts({ env, now: guestNow })
	expect(first.failed).toBe(1)
	const later = new Date(guestNow.getTime() + 24 * 60 * 60 * 1000)
	const second = await pruneExpiredGuestAccounts({ env, now: later })
	expect(second.scanned).toBe(1)
})

test('guest purge does not orphan the guest_accounts row when its delete fails after account deletion', async () => {
	const { db } = createAppDb()
	await seedGuest(db, 'guest3', '2026-09-01T00:00:00.000Z')
	deleteUserAccount.mockImplementation(async (input: { dbUserId: number }) => {
		await db
			.prepare(`DELETE FROM users WHERE id = ?`)
			.bind(input.dbUserId)
			.run()
	})
	let failGuestDelete = true
	const flakyDb = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === 'prepare') {
				return (sql: string) => {
					if (failGuestDelete && sql.startsWith('DELETE FROM guest_accounts')) {
						failGuestDelete = false
						throw new Error('D1_ERROR: network connection lost')
					}
					return target.prepare(sql)
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	const env = { APP_DB: flakyDb, AUDIT_DB: createAuditDb() } as unknown as Env
	await pruneExpiredGuestAccounts({ env, now: guestNow })
	await pruneExpiredGuestAccounts({
		env,
		now: new Date(guestNow.getTime() + 60 * 60 * 1000),
	})
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM guest_accounts WHERE person_id = 'guest3'`,
		)
		.first<{ n: number }>()
	expect(remaining?.n).toBe(0)
})

test('soft-delete purge keeps processing candidates when the failure audit write fails', async () => {
	const { db } = createAppDb()
	const deletingAt = '2026-01-01T00:00:00.000Z'
	await seedUser(db, { id: 1, stableUserId: 'legacy-a', deletingAt })
	await seedUser(db, { id: 2, stableUserId: 'legacy-b', deletingAt })
	finishLegacyUserDeletion.mockImplementation(
		async (input: { dbUserId: number; stableUserId: string }) => {
			if (input.stableUserId === 'legacy-a') throw new Error('cleanup failed')
			await db
				.prepare(`DELETE FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.run()
			return { alreadyGone: false }
		},
	)
	const env = {
		APP_DB: db,
		AUDIT_DB: failingAuditDb,
		SOFT_DELETE_PURGE_ENABLED: 'true',
	} as unknown as Env
	const result = await pruneSoftDeleted({
		env,
		now: new Date('2026-10-01T12:00:00.000Z'),
	}).catch((error: unknown) => ({ threw: String(error) }))
	expect(finishLegacyUserDeletion).toHaveBeenCalledTimes(2)
	expect(result).toMatchObject({ failed: 1, purged: 1 })
})

async function seedArtifact(
	db: D1Database,
	input: { id: string; sourceId: string; createdAt: string },
) {
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point,
				kv_key, created_at, updated_at
			) VALUES (?, 'owner-1', ?, ?, 'module', ?, 'index.ts', ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.sourceId,
			`commit-${input.id}`,
			input.id,
			`bundle:${input.id}`,
			input.createdAt,
			input.createdAt,
		)
		.run()
}

test('published bundle retention advances past artifacts skipped for an active repo session', async () => {
	const { db } = createAppDb()
	busySources.add('busy-source')
	for (let index = 0; index < 100; index += 1) {
		await seedArtifact(db, {
			id: `busy-${String(index).padStart(3, '0')}`,
			sourceId: 'busy-source',
			createdAt: '2026-01-01T00:00:00.000Z',
		})
	}
	await seedArtifact(db, {
		id: 'idle-stale',
		sourceId: 'idle-source',
		createdAt: '2026-02-01T00:00:00.000Z',
	})
	const { kv } = createMemoryKvNamespace({})
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditDb(),
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env
	const result = await pruneRetention({
		env,
		now: new Date('2026-10-01T12:00:00.000Z'),
		timeBudgetMs: 300,
	})
	const idle = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM published_bundle_artifacts WHERE id = 'idle-stale'`,
		)
		.first<{ n: number }>()
	process.stdout.write(
		`published batches ${JSON.stringify(result.batchesPerTable.published_bundle_artifacts)} repo session checks ${hasActiveRepoSessionForSource.mock.calls.length}\n`,
	)
	expect(idle?.n).toBe(0)
})

test('retention keeps pruning later tables when one table task throws', async () => {
	const { db } = createAppDb()
	await db
		.prepare(
			`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at) VALUES ('evt_old', 'invoice.paid', '2026-01-01T00:00:00.000Z')`,
		)
		.run()
	const { kv } = createMemoryKvNamespace({})
	const env = {
		APP_DB: db,
		AUDIT_DB: failingAuditDb,
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env
	await pruneRetention({
		env,
		now: new Date('2026-10-01T12:00:00.000Z'),
	}).catch(() => null)
	const left = await db
		.prepare(`SELECT COUNT(*) AS n FROM stripe_webhook_events`)
		.first<{ n: number }>()
	expect(left?.n).toBe(0)
})

test('OAuth purge grant phase revokes more than one expired grant per run when budget allows', async () => {
	const initial: Record<string, string> = {}
	for (let index = 0; index < 5; index += 1) {
		initial[`grant:user${index}:g${index}`] = JSON.stringify({
			clientId: 'https://client.example.com/metadata.json',
			expiresAt: 1,
		})
	}
	const { kv, store } = createMemoryKvNamespace(initial)
	const stored = new Map<string, unknown>()
	const storage = {
		async get(key: string) {
			return structuredClone(stored.get(key))
		},
		async put(key: string, value: unknown) {
			stored.set(key, structuredClone(value))
		},
	}
	const coordinator = new OAuthPurgeCoordinator(
		{ storage } as unknown as DurableObjectState,
		{ OAUTH_KV: kv } as unknown as Env,
	)
	const result = await coordinator.run({ scheduledAt: Date.now() })
	const grantsLeft = [...store.keys()].filter((key) => key.startsWith('grant:'))
	process.stdout.write(
		`grant phase result ${JSON.stringify(result)} grants left ${grantsLeft.length}\n`,
	)
	expect(result.grantsPurged).toBe(5)
})
