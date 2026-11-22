vi.unmock('#worker/audit-log.ts')

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	type D1FailureRule,
	withD1Failures,
} from '#worker/test-support/d1-failures.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { pruneUnverifiedAccounts } from './unverified-account-purge.ts'

const captureException = vi.fn()

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isInitialized: () => true,
	getClient: () => ({
		getOptions: () => ({ dsn: 'https://key@sentry.test/1' }),
	}),
	withScope: (callback: (scope: unknown) => void) =>
		callback({ setLevel() {}, setTag() {}, setContext() {} }),
	captureException: (error: unknown) => captureException(error),
}))

const now = new Date('2026-09-02T12:00:00.000Z')
const networkLost = 'D1_ERROR: Network connection lost.'
const internal = 'D1_ERROR: internal error; reference = abc123'
const exhaustedReason =
	'TransientRetryBudgetExhausted: Atomic D1 account deletion failed: Transient D1 retry budget exhausted after 1000ms of 1000ms backoff'

beforeEach(() => {
	captureException.mockClear()
	consoleWarn.mockImplementation(() => {})
})

function transient(count: number) {
	return Array.from({ length: count }, (_, index) =>
		index % 2 === 0 ? networkLost : internal,
	)
}

/** The claim's first `UPDATE users SET deleting_at` for one users row. */
function onClaim(dbUserId: number, errors: Array<string>): D1FailureRule {
	return {
		matches: (query, params) =>
			query.includes('SET deleting_at') && params.at(-1) === dbUserId,
		errors,
	}
}

/** The atomic D1 batch at the end of one users row's account deletion. */
function onDeletionBatch(
	dbUserId: number,
	errors: Array<string>,
): D1FailureRule {
	return {
		matches: (query, params) =>
			query.includes('DELETE FROM users WHERE id = ?') &&
			params.at(-1) === dbUserId,
		errors,
	}
}

function harness(rules: Array<D1FailureRule> = []) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL('../../audit-migrations/0001-audit-events.sql', import.meta.url),
			'utf8',
		),
	)
	const executions: Array<string> = []
	const env = {
		...createSuccessfulDeletionEnv(
			withD1Failures(createD1FromSqlite(sqlite), rules, executions),
		),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
	} as Env
	let nowMs = 0
	const sleeps: Array<number> = []
	return {
		executions,
		sleeps,
		run(input: { timeBudgetMs?: number } = {}) {
			return pruneUnverifiedAccounts({
				env,
				now,
				...input,
				clock: () => nowMs,
				sleep: async (ms) => {
					sleeps.push(ms)
					nowMs += ms
				},
			})
		},
		seed(username: string) {
			const email = `${username}@example.com`
			const stableUserId = testStableUserIdFromEmail(email)
			const inserted = sqlite
				.prepare(
					`INSERT INTO users (username, email, password_hash, stable_user_id, created_at)
					VALUES (?, ?, 'hash', ?, ?)`,
				)
				.run(username, email, stableUserId, '2026-08-01T00:00:00.000Z')
			return { id: Number(inserted.lastInsertRowid), stableUserId }
		},
		user(id: number) {
			return sqlite
				.prepare(`SELECT deleting_at FROM users WHERE id = ?`)
				.get(id) as { deleting_at: string | null } | undefined
		},
		auditActions() {
			return (
				auditSqlite
					.prepare(`SELECT action FROM audit_events ORDER BY id ASC`)
					.all() as Array<{ action: string }>
			).map((row) => row.action)
		},
	}
}

test('a transient error on the deletion batch is retried and the account is purged', async () => {
	const h = harness([onDeletionBatch(1, transient(2))])
	const user = h.seed('stale-a')
	expect(await h.run()).toMatchObject({ purged: 1, failed: 0 })
	expect(h.sleeps).toEqual([100, 200])
	expect(h.user(user.id)).toBeUndefined()
	expect(h.auditActions()).toEqual(['unverified_account_purged'])
})

test('a permanent error is not retried and records the ordinary purge failure', async () => {
	const h = harness([
		onDeletionBatch(1, [
			'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT',
		]),
	])
	const user = h.seed('stale-a')
	const result = await h.run()
	expect(result).toMatchObject({ purged: 0, failed: 1 })
	expect(h.sleeps).toEqual([])
	expect(
		h.executions.filter((query) =>
			query.includes('DELETE FROM users WHERE id = ?'),
		),
	).toHaveLength(1)
	expect(h.user(user.id)).toBeDefined()
	expect(h.auditActions()).toEqual(['unverified_account_purge_failed'])
	expect(captureException.mock.calls[0]![0]).toMatchObject({
		name: 'AccountDeletionCleanupError',
	})
})

test('an account that exhausts its retry budget fails with its own audit, keeps its claim, and the next account continues', async () => {
	const retrying = harness([
		onClaim(1, transient(3)),
		onDeletionBatch(1, transient(3)),
	])
	const a = retrying.seed('stale-a')
	const b = retrying.seed('stale-b')
	expect([a.id, b.id]).toEqual([1, 2])
	const result = await retrying.run()
	expect(result).toMatchObject({ purged: 1, failed: 1 })
	expect(result.outcomes).toEqual([
		{
			stableUserId: a.stableUserId,
			ageDays: 32,
			outcome: 'failed',
			error: exhaustedReason,
			warnings: [
				'Atomic D1 account deletion failed: Transient D1 retry budget exhausted after 1000ms of 1000ms backoff',
			],
		},
		{ stableUserId: b.stableUserId, ageDays: 32, outcome: 'purged' },
	])
	expect(retrying.sleeps).toEqual([100, 200, 400, 100, 200])
	expect(retrying.user(a.id)?.deleting_at).toBeTruthy()
	expect(retrying.user(b.id)).toBeUndefined()
	expect(retrying.auditActions()).toEqual([
		'purge.retry_budget_exhausted',
		'unverified_account_purged',
	])
	expect(captureException).toHaveBeenCalledTimes(1)
	expect(captureException.mock.calls[0]![0]).toMatchObject({
		name: 'TransientRetryBudgetExhausted',
	})
})

test('the retry budget is per account, not per pass', async () => {
	const h = harness([
		onClaim(1, transient(3)),
		onClaim(2, transient(3)),
		onDeletionBatch(1, transient(2)),
		onDeletionBatch(2, transient(2)),
	])
	const a = h.seed('stale-a')
	const b = h.seed('stale-b')
	expect([a.id, b.id]).toEqual([1, 2])
	expect(await h.run()).toMatchObject({ purged: 2, failed: 0 })
	expect(h.sleeps).toEqual([100, 200, 400, 100, 200, 100, 200, 400, 100, 200])
})

test('backoff counts toward the pass time budget', async () => {
	const h = harness([onClaim(1, transient(3))])
	const a = h.seed('stale-a')
	const b = h.seed('stale-b')
	expect(a.id).toBe(1)
	const result = await h.run({ timeBudgetMs: 500 })
	expect(result).toMatchObject({
		scanned: 2,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: true,
	})
	expect(h.sleeps).toEqual([100, 200, 400])
	expect(h.user(b.id)).toEqual({ deleting_at: null })
})
