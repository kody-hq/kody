import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	type D1FailureRule,
	withD1Failures,
} from '#worker/test-support/d1-failures.ts'
import {
	transientD1ItemRetryEnv,
	TransientRetryBudgetExhausted,
} from '#worker/d1-item-retry.ts'

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

// Two statements per org purge, run through the item retry the lane attached.
vi.mock('./hard-purge.ts', () => ({
	hardPurgeOrg: async (input: { env: Env; orgId: string }) => {
		const db = transientD1ItemRetryEnv(input.env).APP_DB
		await db
			.prepare(`UPDATE orgs SET display_name = ? WHERE id = ?`)
			.bind('purging', input.orgId)
			.run()
		await db.prepare(`DELETE FROM orgs WHERE id = ?`).bind(input.orgId).run()
	},
	hardPurgeSoftDeletedUser: vi.fn(),
	finishLegacyUserDeletion: vi.fn(),
}))

const { pruneSoftDeleted } = await import('./purge.ts')

const now = new Date('2026-10-01T12:00:00.000Z')
const networkLost = 'D1_ERROR: Network connection lost.'
const timeout =
	'D1_ERROR: Durable Object storage operation exceeded timeout which caused object to be reset.'

beforeEach(() => {
	captureException.mockClear()
	consoleWarn.mockImplementation(() => {})
})

function transient(count: number) {
	return Array.from({ length: count }, (_, index) =>
		index % 2 === 0 ? networkLost : timeout,
	)
}

function onOrg(
	sql: string,
	orgId: string,
	errors: Array<string>,
): D1FailureRule {
	return {
		matches: (query, params) => query.includes(sql) && params.includes(orgId),
		errors,
	}
}

async function harness(input: {
	orgIds: Array<string>
	rules?: Array<D1FailureRule>
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../audit-migrations/0002-org-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	for (const orgId of input.orgIds)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, deleted_at, created_at, updated_at)
				VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
			)
			.run(
				orgId,
				orgId,
				orgId,
				'2025-08-01T00:00:00.000Z',
				'2025-01-01T00:00:00.000Z',
				'2025-08-01T00:00:00.000Z',
			)
	const executions: Array<string> = []
	const env = {
		APP_DB: withD1Failures(
			createD1FromSqlite(sqlite),
			input.rules ?? [],
			executions,
		),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		SOFT_DELETE_PURGE_ENABLED: 'true',
	} as Env
	let nowMs = 0
	const sleeps: Array<number> = []
	return {
		executions,
		sleeps,
		run(options: { timeBudgetMs?: number } = {}) {
			return pruneSoftDeleted({
				env,
				now,
				dryRun: false,
				...options,
				clock: () => nowMs,
				sleep: async (ms) => {
					sleeps.push(ms)
					nowMs += ms
				},
			})
		},
		org(orgId: string) {
			return sqlite
				.prepare(`SELECT deleting_at FROM orgs WHERE id = ?`)
				.get(orgId) as { deleting_at: string | null } | undefined
		},
		audits() {
			return auditSqlite
				.prepare(
					`SELECT org_id, action, result, details_json FROM org_audit_events ORDER BY rowid`,
				)
				.all() as Array<{
				org_id: string
				action: string
				result: string
				details_json: string | null
			}>
		},
	}
}

test('a transient error on a purge statement is retried and the org is purged', async () => {
	const h = await harness({
		orgIds: ['org-1'],
		rules: [onOrg('SET display_name', 'org-1', transient(2))],
	})
	expect(await h.run()).toMatchObject({ purged: 1, failed: 0 })
	expect(h.sleeps).toEqual([100, 200])
	expect(
		h.executions.filter((query) => query.includes('SET display_name')),
	).toHaveLength(3)
	expect(h.org('org-1')).toBeUndefined()
})

test('a permanent error is not retried and records the ordinary purge failure', async () => {
	const h = await harness({
		orgIds: ['org-1', 'org-2'],
		rules: [
			onOrg('SET display_name', 'org-1', [
				'D1_ERROR: UNIQUE constraint failed: orgs.slug',
			]),
			onOrg('SET deleting_at', 'org-2', [
				'D1_ERROR: database is locked: SQLITE_BUSY',
			]),
		],
	})
	const result = await h.run()
	expect(result).toMatchObject({ purged: 0, failed: 2 })
	expect(h.sleeps).toEqual([])
	expect(
		h.executions.filter((query) => query.includes('SET deleting_at')),
	).toHaveLength(2)
	expect(h.audits().map((row) => [row.org_id, row.action])).toEqual([
		['org-1', 'org.purge_failed'],
		['org-2', 'org.purge_failed'],
	])
	expect(captureException).not.toHaveBeenCalled()
})

test('an org that exhausts its retry budget fails with its own audit, keeps its claim, and the next org continues', async () => {
	const h = await harness({
		orgIds: ['org-1', 'org-2'],
		rules: [
			onOrg('SET display_name', 'org-1', transient(3)),
			onOrg('DELETE FROM orgs', 'org-1', transient(4)),
		],
	})
	const result = await h.run()
	expect(result).toMatchObject({ purged: 1, failed: 1 })
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			id: 'org-1',
			outcome: 'failed',
			error:
				'TransientRetryBudgetExhausted: Transient D1 retry budget exhausted after 1000ms of 1000ms backoff',
		}),
		expect.objectContaining({ id: 'org-2', outcome: 'purged' }),
	])
	expect(h.sleeps).toEqual([100, 200, 400, 100, 200])
	expect(h.org('org-1')).toEqual({ deleting_at: now.toISOString() })
	expect(h.org('org-2')).toBeUndefined()
	const audits = h.audits()
	expect(audits).toHaveLength(1)
	expect(audits[0]).toMatchObject({
		org_id: 'org-1',
		action: 'purge.retry_budget_exhausted',
		result: 'failure',
	})
	expect(JSON.parse(audits[0]!.details_json!)).toEqual({
		kind: 'org',
		lane: 'soft_delete',
		spentMs: 1000,
		budgetMs: 1000,
		// The failure-detail redaction treats `D1_ERROR:` as an id token.
		lastError: '<id> Network connection lost.',
	})
	expect(captureException).toHaveBeenCalledTimes(1)
	expect(captureException.mock.calls[0]![0]).toBeInstanceOf(
		TransientRetryBudgetExhausted,
	)
})

test('the retry budget is per org, not per pass', async () => {
	const rules = ['org-1', 'org-2'].flatMap((orgId) => [
		onOrg('SET display_name', orgId, transient(3)),
		onOrg('DELETE FROM orgs', orgId, transient(2)),
	])
	const h = await harness({ orgIds: ['org-1', 'org-2'], rules })
	expect(await h.run()).toMatchObject({ purged: 2, failed: 0 })
	expect(h.sleeps).toEqual([100, 200, 400, 100, 200, 100, 200, 400, 100, 200])
})

test('backoff counts toward the pass time budget', async () => {
	const h = await harness({
		orgIds: ['org-1', 'org-2'],
		rules: [onOrg('SET display_name', 'org-1', transient(3))],
	})
	const result = await h.run({ timeBudgetMs: 500 })
	expect(result).toMatchObject({
		purged: 1,
		failed: 0,
		timeBudgetExhausted: true,
	})
	expect(h.sleeps).toEqual([100, 200, 400])
	expect(h.org('org-2')).toEqual({ deleting_at: null })
})
