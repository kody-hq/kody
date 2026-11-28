import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const deleteUserAccount = vi.fn()
vi.mock('#app/account-deletion.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	deleteUserAccount: (input: unknown) => deleteUserAccount(input),
}))
const scheduleUserDeletedEvent = vi.fn()
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent: (input: unknown) => scheduleUserDeletedEvent(input),
}))

let auditGate: Promise<void> | null = null
let auditEntered = 0
let auditSettled = 0
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<object>()
	return {
		...actual,
		logAuditEvent: async (event: { action: string }) => {
			auditEntered += 1
			if (auditGate) await auditGate
			auditSettled += 1
			return { persisted: true, failedSinks: [], event: event.action }
		},
	}
})

const finishLegacyUserDeletion = vi.fn()
vi.mock('#worker/orgs/hard-purge.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	hardPurgeOrg: vi.fn(),
	hardPurgeSoftDeletedUser: vi.fn(),
	finishLegacyUserDeletion: (input: unknown) => finishLegacyUserDeletion(input),
}))

const { pruneExpiredGuestAccounts } =
	await import('#worker/guest/guest-account-purge.ts')
const { pruneSoftDeleted } = await import('#worker/orgs/purge.ts')

beforeEach(() => {
	deleteUserAccount.mockReset()
	finishLegacyUserDeletion.mockReset()
	scheduleUserDeletedEvent.mockReset()
	auditGate = null
	auditEntered = 0
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
	let returned = false
	const pending = pruneExpiredGuestAccounts({ env, now: guestNow }).then(
		(result) => {
			returned = true
			return result
		},
	)
	await vi.waitFor(() => expect(auditEntered).toBe(1))
	await new Promise((resolve) => setTimeout(resolve, 0))
	expect(returned).toBe(false)
	release()
	const result = await pending
	expect(result.purged).toBe(1)
	expect(auditSettled).toBe(1)
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
	finishLegacyUserDeletion.mockImplementation(
		async (input: { dbUserId: number }) => {
			await db
				.prepare(`DELETE FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.run()
			return { alreadyGone: false }
		},
	)
	const second = await pruneExpiredGuestAccounts({ env, now: later })
	expect(second).toEqual({ scanned: 1, purged: 1, failed: 0 })
	expect(finishLegacyUserDeletion).toHaveBeenCalledTimes(1)
	expect(deleteUserAccount).toHaveBeenCalledTimes(1)
	expect(scheduleUserDeletedEvent).toHaveBeenCalledTimes(1)
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM guest_accounts WHERE person_id = 'guest2'`,
		)
		.first<{ n: number }>()
	expect(remaining?.n).toBe(0)
})

test('guest purge still sends the deletion event when a retry removes the guest and then fails', async () => {
	const { db } = createAppDb()
	await seedGuest(db, 'guest4', '2026-09-01T00:00:00.000Z')
	deleteUserAccount.mockImplementationOnce(async () => {
		await db
			.prepare(
				`UPDATE users SET deleting_at = ? WHERE stable_user_id = 'guest4'`,
			)
			.bind(guestNow.toISOString())
			.run()
		throw new Error('account_deletion_cleanup_incomplete')
	})
	const env = { APP_DB: db, AUDIT_DB: createAuditDb() } as unknown as Env
	await pruneExpiredGuestAccounts({ env, now: guestNow })
	finishLegacyUserDeletion.mockImplementation(
		async (input: { dbUserId: number }) => {
			await db
				.prepare(`DELETE FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.run()
			throw new Error('personal_org_purge_failed')
		},
	)
	const later = new Date(guestNow.getTime() + 24 * 60 * 60 * 1000)
	const second = await pruneExpiredGuestAccounts({ env, now: later })
	expect(second).toEqual({ scanned: 1, purged: 1, failed: 0 })
	expect(scheduleUserDeletedEvent).toHaveBeenCalledTimes(1)
	expect(auditSettled).toBe(1)
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM guest_accounts WHERE person_id = 'guest4'`,
		)
		.first<{ n: number }>()
	expect(remaining?.n).toBe(0)
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
	expect(scheduleUserDeletedEvent).toHaveBeenCalledTimes(1)
	expect(auditSettled).toBe(1)
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
