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

const { pruneRetention } = await import('#app/retention.ts')
const { OAuthPurgeCoordinator } = await import('#worker/oauth-purge.ts')

beforeEach(() => {
	busySources.clear()
	hasActiveRepoSessionForSource.mockClear()
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
	await pruneRetention({
		env,
		now: new Date('2026-10-01T12:00:00.000Z'),
		timeBudgetMs: 300,
	})
	const idle = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM published_bundle_artifacts WHERE id = 'idle-stale'`,
		)
		.first<{ n: number }>()
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
	const { kv } = createMemoryKvNamespace(initial)
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
	expect(result.grantsPurged).toBe(5)
})
