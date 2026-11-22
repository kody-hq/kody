vi.unmock('#worker/audit-log.ts')

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { pruneUnverifiedAccounts } from '#worker/account/unverified-account-purge.ts'
import { pruneExpiredGuestAccounts } from '#worker/guest/guest-account-purge.ts'
import {
	createGuestAccount,
	guestFullAccessMs,
	guestHoldMs,
} from '#worker/guest/guest-accounts.ts'
import { runRetentionTickLane } from './tick.ts'

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent: vi.fn(),
	scheduleGuestClaimedEvent: vi.fn(),
	scheduleUserCreatedEvent: vi.fn(),
}))

const now = new Date('2026-09-02T12:00:00.000Z')
const dayMs = 24 * 60 * 60 * 1000
const secretStoreKey = 'guest-test-secret-store-key-32-characters-ok'

type Fault = {
	/** Throw from `run()` of a prepared statement whose SQL and bindings match. */
	run?: (sql: string, params: Array<unknown>) => Error | null
	/** Throw from `batch()` when it returns an error for these statements. */
	batch?: (queries: Array<string>) => Error | null
}

function faultyD1(base: D1Database, fault: Fault): D1Database {
	return {
		prepare(sql: string) {
			const prepared = base.prepare(sql)
			return {
				query: sql,
				bind(...params: Array<unknown>) {
					const bound = prepared.bind(...params) as D1PreparedStatement & {
						query?: string
					}
					return {
						query: sql,
						all: () => bound.all(),
						first: () => bound.first(),
						raw: () => bound.raw(),
						async run() {
							const error = fault.run?.(sql, params)
							if (error) throw error
							return bound.run()
						},
					}
				},
			}
		},
		async batch(statements: Array<{ query?: string }>) {
			const error = fault.batch?.(statements.map((s) => s.query ?? ''))
			if (error) throw error
			return base.batch(statements as Array<D1PreparedStatement>)
		},
		exec: (query: string) => base.exec(query),
	} as unknown as D1Database
}

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	applyAllMigrations(
		sqlite,
		new URL('../../../../jobs-worker/migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const envFor = (appDb: D1Database) =>
		({
			...createSuccessfulDeletionEnv(appDb),
			AUDIT_DB: createD1FromSqlite(auditSqlite),
			SECRET_STORE_KEY: secretStoreKey,
		}) as unknown as Env
	function seedUnverified(username: string, createdDaysAgo: number) {
		const inserted = sqlite
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id, created_at)
				VALUES (?, ?, 'hash', ?, ?)`,
			)
			.run(
				username,
				`${username}@example.com`,
				`person_${username}`,
				new Date(now.getTime() - createdDaysAgo * dayMs).toISOString(),
			)
		return Number(inserted.lastInsertRowid)
	}
	function usernames() {
		return (
			sqlite
				.prepare(`SELECT username FROM users ORDER BY username`)
				.all() as Array<{
				username: string
			}>
		).map((row) => row.username)
	}
	return { sqlite, db, envFor, seedUnverified, usernames }
}

const simulatedD1Failure = () =>
	new Error('D1_ERROR: SQLITE_CONSTRAINT: simulated claim write failure')

test('unverified purge: a claim write failure on one account is a per-account failure, not a lane abort', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const harness = createHarness()
	const oldest = harness.seedUnverified('oldest', 9)
	harness.seedUnverified('second', 8)
	const env = harness.envFor(
		faultyD1(harness.db, {
			run: (sql, params) =>
				/UPDATE users\s+SET deleting_at/.test(sql) && params[2] === oldest
					? simulatedD1Failure()
					: null,
		}),
	)

	const result = await pruneUnverifiedAccounts({ env, now }).then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error: String(error) }),
	)

	// Expected: the oldest account is reported failed and the second one is
	// still purged in the same pass, like the soft-delete purge does.
	expect(result).toMatchObject({
		ok: true,
		value: { scanned: 2, purged: 1, failed: 1 },
	})
	expect(harness.usernames()).toEqual(['oldest'])
})

test('unverified_account_purge tick: an unverified-purge failure skips the guest purge for the whole tick', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const harness = createHarness()
	const created = await createGuestAccount({
		env: harness.envFor(harness.db),
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: new Date(now.getTime() - guestFullAccessMs - guestHoldMs - dayMs),
	})
	if (!created.ok) throw new Error('guest was not created')
	const oldest = harness.seedUnverified('oldest', 9)
	const env = harness.envFor(
		faultyD1(harness.db, {
			run: (sql, params) =>
				/UPDATE users\s+SET deleting_at/.test(sql) && params[2] === oldest
					? simulatedD1Failure()
					: null,
		}),
	)

	const tick = await runRetentionTickLane({
		env,
		lane: 'unverified_account_purge',
		scheduledAt: now,
	})

	// Expected: the expired guest is purged even though one unverified account
	// could not be claimed.
	expect(tick.ok).toBe(true)
	expect(harness.usernames()).not.toContain(created.username)
})

test('guest purge: a guest whose deletion failed after the fence was stamped is retried by the guest lane', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const harness = createHarness()
	const guestCreatedAt = new Date(
		now.getTime() - guestFullAccessMs - guestHoldMs - dayMs,
	)
	const created = await createGuestAccount({
		env: harness.envFor(harness.db),
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: guestCreatedAt,
	})
	if (!created.ok) throw new Error('guest was not created')
	let failAtomicDelete = true
	const env = harness.envFor(
		faultyD1(harness.db, {
			batch: (queries) => {
				if (
					failAtomicDelete &&
					queries.some((q) => /DELETE FROM users WHERE id = \?/.test(q))
				) {
					failAtomicDelete = false
					return new Error(
						'D1_ERROR: SQLITE_FULL: simulated atomic delete failure',
					)
				}
				return null
			},
		}),
	)

	const first = await pruneExpiredGuestAccounts({ env, now })
	expect(first).toEqual({ scanned: 1, purged: 0, failed: 1 })
	const fence = harness.sqlite
		.prepare(`SELECT deleting_at FROM users WHERE stable_user_id = ?`)
		.get(created.personId) as { deleting_at: string | null }
	expect(fence.deleting_at).not.toBeNull()

	// A day later the transient failure is gone. Expected: the guest lane
	// retries and deletes the guest.
	const later = new Date(now.getTime() + dayMs)
	const second = await pruneExpiredGuestAccounts({ env, now: later })
	expect(second).toEqual({ scanned: 1, purged: 1, failed: 0 })
	expect(harness.usernames()).not.toContain(created.username)
})

test('guest purge: guest_accounts row is not orphaned when its delete fails after the user row is gone', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const harness = createHarness()
	const created = await createGuestAccount({
		env: harness.envFor(harness.db),
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: new Date(now.getTime() - guestFullAccessMs - guestHoldMs - dayMs),
	})
	if (!created.ok) throw new Error('guest was not created')
	let failGuestRowDelete = true
	const env = harness.envFor(
		faultyD1(harness.db, {
			run: (sql) => {
				if (failGuestRowDelete && /DELETE FROM guest_accounts/.test(sql)) {
					failGuestRowDelete = false
					return new Error(
						'D1_ERROR: SQLITE_FULL: simulated guest row delete failure',
					)
				}
				return null
			},
		}),
	)

	const first = await pruneExpiredGuestAccounts({ env, now })
	expect(first.failed).toBe(1)
	const later = new Date(now.getTime() + dayMs)
	await pruneExpiredGuestAccounts({ env, now: later })
	const remaining = harness.sqlite
		.prepare(`SELECT COUNT(*) AS count FROM guest_accounts WHERE person_id = ?`)
		.get(created.personId) as { count: number }
	// Expected: a later pass removes the guest_accounts row.
	expect(remaining.count).toBe(0)
})

test('guest purge: a failed guest deletion is handed to the soft-delete legacy lane instead of the guest lane', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const { listSoftDeletePurgeCandidates } =
		await import('#worker/orgs/purge.ts')
	const harness = createHarness()
	const created = await createGuestAccount({
		env: harness.envFor(harness.db),
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: new Date(now.getTime() - guestFullAccessMs - guestHoldMs - dayMs),
	})
	if (!created.ok) throw new Error('guest was not created')
	let failAtomicDelete = true
	const env = harness.envFor(
		faultyD1(harness.db, {
			batch: (queries) => {
				if (
					failAtomicDelete &&
					queries.some((q) => /DELETE FROM users WHERE id = \?/.test(q))
				) {
					failAtomicDelete = false
					return new Error(
						'D1_ERROR: SQLITE_FULL: simulated atomic delete failure',
					)
				}
				return null
			},
		}),
	)
	await pruneExpiredGuestAccounts({ env, now })
	// markAccountDeleting stamps the fence with the wall clock.
	const later = new Date(Date.now() + dayMs)
	const preview = await listSoftDeletePurgeCandidates({ env, now: later })
	// Expected: the guest stays owned by the guest lane (guest_accounts row,
	// user.deleted lifecycle event, guest_account_purged audit). Actual: it is
	// listed as a legacy pre-soft-delete deletion that finishLegacyUserDeletion
	// would finish, bypassing all three.
	expect(preview.candidates).not.toContainEqual(
		expect.objectContaining({ id: created.personId, legacy: true }),
	)
})
