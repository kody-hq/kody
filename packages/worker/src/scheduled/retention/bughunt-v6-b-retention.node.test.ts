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

const repoSessionLookup = vi.hoisted(() => ({
	impl: null as null | ((input: { sourceId: string }) => Promise<boolean>),
}))
vi.mock('#worker/repo/repo-sessions.ts', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('#worker/repo/repo-sessions.ts')>()
	return {
		...original,
		hasActiveRepoSessionForSource: (
			env: Parameters<typeof original.hasActiveRepoSessionForSource>[0],
			input: Parameters<typeof original.hasActiveRepoSessionForSource>[1],
		) =>
			repoSessionLookup.impl
				? repoSessionLookup.impl(input)
				: original.hasActiveRepoSessionForSource(env, input),
	}
})

// The out-of-band org cleanup is outside these lanes' files; stub it so the
// test reaches deleteOrgRows in orgs/hard-purge.ts.
vi.mock('#app/account-deletion.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#app/account-deletion.ts')>()),
	purgeOwnerOutOfBandSurfaces: async () => undefined,
}))
vi.mock(
	'#worker/integrations/pinned-connections.ts',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('#worker/integrations/pinned-connections.ts')
		>()),
		wipePinnedConnectionsForOrg: async () => undefined,
	}),
)

const { pruneRetention } = await import('#app/retention.ts')
const { pruneSoftDeleted } = await import('#worker/orgs/purge.ts')

const now = new Date('2026-10-01T12:00:00.000Z')
const dayMs = 24 * 60 * 60 * 1000
const daysAgo = (days: number) =>
	new Date(now.getTime() - days * dayMs).toISOString()

function auditDb(file: string) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(`../../../audit-migrations/${file}`, import.meta.url),
			'utf8',
		),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function appDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedStaleArtifact(sqlite: DatabaseSync, id: string) {
	sqlite
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, entry_point,
				kv_key, created_at, updated_at
			) VALUES (?, 'user-1', ?, 'commit-old', 'module', 'src/index.ts', ?, ?, ?)`,
		)
		.run(id, `source-${id}`, `kv:${id}`, daysAgo(60), daysAgo(60))
}

test('retention: one repo-session lookup failure aborts every later retention table in the pass', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const app = appDb()
	const audit = auditDb('0001-audit-events.sql')
	seedStaleArtifact(app.sqlite, 'artifact-1')
	app.sqlite
		.prepare(
			`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at)
			VALUES ('evt_old', 'invoice.paid', ?)`,
		)
		.run(daysAgo(60))
	repoSessionLookup.impl = async () => {
		throw new Error('RepoSessionIndex RPC failed: Durable Object reset')
	}
	const env = {
		APP_DB: app.db,
		AUDIT_DB: audit.db,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
	} as unknown as Env
	try {
		const result = await pruneRetention({ env, now }).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error: String(error) }),
		)
		// Expected: the artifact is skipped (like a KV delete failure is) and
		// the rest of the retention tables are still pruned.
		expect(result).toEqual({ ok: true, value: expect.anything() })
		const stripe = app.sqlite
			.prepare(`SELECT COUNT(*) AS count FROM stripe_webhook_events`)
			.get() as { count: number }
		expect(stripe.count).toBe(0)
	} finally {
		repoSessionLookup.impl = null
	}
})

test('retention: a failed bundle KV delete is never retried because the D1 row is deleted first', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const app = appDb()
	const audit = auditDb('0001-audit-events.sql')
	seedStaleArtifact(app.sqlite, 'artifact-1')
	repoSessionLookup.impl = async () => false
	let failBlobDelete = true
	const kvDelete = vi.fn(async (key: string) => {
		if (key === 'kv:artifact-1' && failBlobDelete) {
			failBlobDelete = false
			throw new Error('KV delete failed: 503')
		}
	})
	const env = {
		APP_DB: app.db,
		AUDIT_DB: audit.db,
		BUNDLE_ARTIFACTS_KV: { delete: kvDelete },
	} as unknown as Env
	try {
		const first = await pruneRetention({ env, now })
		expect(first.publishedBundleArtifacts.kvDeleteErrors).toBe(1)
		await pruneRetention({ env, now: new Date(now.getTime() + 60 * 60_000) })
		// Expected: the blob delete is retried on a later run.
		expect(
			kvDelete.mock.calls.filter(([key]) => key === 'kv:artifact-1'),
		).toHaveLength(2)
	} finally {
		repoSessionLookup.impl = null
	}
})

test('soft-delete purge: an org.purged audit write failure after the org is gone is reported as a failed purge', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const app = appDb()
	const audit = auditDb('0002-org-audit-events.sql')
	const orgId = 'org_bughunt_team'
	const deletedAt = '2025-08-01T00:00:00.000Z'
	app.sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, deleted_at, created_at, updated_at)
			VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
		)
		.run(orgId, orgId, orgId, deletedAt, '2025-01-01T00:00:00.000Z', deletedAt)
	const failingAuditDb = {
		prepare(sql: string) {
			const prepared = audit.db.prepare(sql)
			return {
				bind(...params: Array<unknown>) {
					const bound = prepared.bind(...params)
					return {
						all: () => bound.all(),
						first: () => bound.first(),
						async run() {
							if (
								/INSERT INTO org_audit_events/.test(sql) &&
								params[6] === 'org.purged'
							) {
								throw new Error('D1_ERROR: SQLITE_FULL: audit database is full')
							}
							return bound.run()
						},
					}
				},
			}
		},
		batch: (s: Array<D1PreparedStatement>) => audit.db.batch(s),
	} as unknown as D1Database
	const env = {
		...createSuccessfulDeletionEnv(app.db),
		AUDIT_DB: failingAuditDb,
		SOFT_DELETE_PURGE_ENABLED: 'true',
	} as unknown as Env

	const result = await pruneSoftDeleted({ env, now })
	const orgRow = app.sqlite
		.prepare(`SELECT COUNT(*) AS count FROM orgs WHERE id = ?`)
		.get(orgId) as { count: number }
	expect(orgRow.count, JSON.stringify(result.outcomes)).toBe(0)
	const failureAudits = audit.sqlite
		.prepare(
			`SELECT action FROM org_audit_events WHERE org_id = ? AND action = 'org.purge_failed'`,
		)
		.all(orgId)
	// Expected: the org is gone, so the outcome is purged and no failure audit
	// is written for it.
	expect(result.outcomes).toEqual([
		expect.objectContaining({ id: orgId, outcome: 'purged' }),
	])
	expect(failureAudits).toEqual([])
})
