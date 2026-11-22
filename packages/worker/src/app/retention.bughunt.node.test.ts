import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const hasActiveRepoSessionForSource = vi.hoisted(() => vi.fn())
vi.mock('#worker/repo/repo-sessions.ts', () => ({
	hasActiveRepoSessionForSource,
}))

const now = new Date('2026-07-07T00:00:00.000Z')
const old = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString()

function seededDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO published_bundle_artifacts
			 (id, user_id, source_id, published_commit, artifact_kind, entry_point, kv_key, created_at, updated_at)
			 VALUES ('a1', 'user-1', 'source-1', 'c1', 'job', 'index.ts', 'kv-a1', ?, ?)`,
		)
		.run(old, old)
	sqlite
		.prepare(
			`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at) VALUES ('evt_old', 'x', ?)`,
		)
		.run(old)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function env(db: D1Database) {
	return {
		APP_DB: db,
		AUDIT_DB: db,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV'>
}

afterEach(() => {
	vi.useRealTimers()
	hasActiveRepoSessionForSource.mockReset()
})

test('bughunt: one failing table (repo-session RPC error on a bundle row) aborts retention for every later table', async () => {
	const { pruneRetention } = await import('./retention.ts')
	const { sqlite, db } = seededDb()
	hasActiveRepoSessionForSource.mockRejectedValue(
		new Error('RepoSessionIndex RPC failed'),
	)
	await pruneRetention({ env: env(db), now }).catch(() => undefined)
	// stripe_webhook_events is unrelated to the failing bundle row; its expired
	// row must still be pruned in this run.
	expect(
		sqlite.prepare(`SELECT event_id FROM stripe_webhook_events`).all(),
	).toEqual([])
})

test('bughunt: a hung repo-session RPC in bundle retention has no deadline and stalls the lane', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	const { pruneRetention } = await import('./retention.ts')
	const { db } = seededDb()
	hasActiveRepoSessionForSource.mockImplementation(
		() => new Promise<boolean>(() => {}),
	)
	let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
	void pruneRetention({ env: env(db), now }).then(
		() => {
			settled = 'resolved'
		},
		() => {
			settled = 'rejected'
		},
	)
	// Far past every outbound ceiling (durableObject is 150s).
	await vi.advanceTimersByTimeAsync(10 * 60_000)
	expect(settled).not.toBe('pending')
})
