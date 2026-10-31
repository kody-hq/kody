import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	agentPackageConversationUseRetentionDays,
	auditEventRetentionDays,
	featureFlagExposureRetentionDays,
	getRetentionPolicyCoverage,
	memorySuppressionRetentionDays,
	platformFeedbackRetentionDays,
	pruneAgentPackageConversationUsesForRetention,
	pruneAuditEventsForRetention,
	pruneFeatureFlagExposuresForRetention,
	pruneMemorySuppressionsForRetention,
	prunePlatformFeedbackForRetention,
	prunePublishedBundleArtifactsForRetention,
	pruneRetention,
	pruneStripeWebhookEventsForRetention,
	pruneUsageRollupsForRetention,
	publishedBundleArtifactRetentionDays,
	shouldRunRetentionCron,
	stripeWebhookEventRetentionDays,
} from './retention.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'

function createRetentionDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	sqlite.exec(`
		CREATE TABLE mcp_memory_conversation_suppressions (
			user_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			PRIMARY KEY (user_id, conversation_id, memory_id)
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			deleted_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE usage_rollups (
			user_id TEXT NOT NULL,
			metric TEXT NOT NULL,
			month TEXT NOT NULL,
			event_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			total_duration_ms INTEGER NOT NULL DEFAULT 0,
			total_cpu_ms INTEGER NOT NULL DEFAULT 0,
			total_bytes INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, metric, month)
		);
		CREATE TABLE feature_flag_exposure_rollups (
			flag_key TEXT NOT NULL,
			user_id TEXT NOT NULL,
			day TEXT NOT NULL,
			enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
			source TEXT NOT NULL,
			exposure_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (flag_key, user_id, day, enabled, source)
		);
		CREATE TABLE audit_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			category TEXT NOT NULL,
			action TEXT NOT NULL,
			result TEXT NOT NULL,
			email_hash TEXT,
			ip_hash TEXT,
			client_id TEXT,
			path TEXT,
			reason TEXT,
			timestamp TEXT NOT NULL
		);
		CREATE TABLE stripe_webhook_events (
			event_id TEXT PRIMARY KEY NOT NULL,
			event_type TEXT NOT NULL,
			processed_at TEXT NOT NULL
		);
		CREATE TABLE platform_feedback (
			id TEXT PRIMARY KEY NOT NULL,
			submitter_user_id TEXT NOT NULL,
			status TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE agent_package_conversation_uses (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			first_used_at TEXT NOT NULL,
			last_used_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id, conversation_id)
		);
		CREATE TABLE IF NOT EXISTS profiles (
			id TEXT PRIMARY KEY NOT NULL,
			org_id TEXT NOT NULL,
			owner_kind TEXT NOT NULL DEFAULT 'person' CHECK (owner_kind IN ('person')),
			acting_user_id TEXT,
			parent_profile_id TEXT REFERENCES profiles (id),
			name TEXT NOT NULL,
			depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5),
			expires_at TEXT,
			revoked_at TEXT,
			revoked_by_user_id TEXT,
			created_by_user_id TEXT NOT NULL,
			created_by_profile_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			CHECK (owner_kind <> 'person' OR acting_user_id IS NOT NULL),
			CHECK ((parent_profile_id IS NULL) = (depth = 1))
		);
		CREATE TABLE grants (
			id TEXT PRIMARY KEY NOT NULL,
			org_id TEXT NOT NULL,
			subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL
		);
		CREATE TABLE grant_permissions (
			grant_id TEXT NOT NULL,
			permission TEXT NOT NULL
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

const now = new Date('2026-07-07T00:00:00.000Z')

function daysAgo(days: number) {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

function insertRows(
	db: DatabaseSync,
	table: string,
	columns: Array<string>,
	rows: Array<Array<SQLInputValue>>,
) {
	const statement = db.prepare(
		`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
	)
	for (const values of rows) statement.run(...values)
}

function selectColumn(db: DatabaseSync, table: string, column: string) {
	return (
		db
			.prepare(`SELECT ${column} FROM ${table} ORDER BY ${column}`)
			.all() as Array<Record<string, unknown>>
	).map((row) => row[column])
}

function insertResolvedFeedback(db: DatabaseSync, ids: Array<string>) {
	const updatedAt = daysAgo(platformFeedbackRetentionDays + 1)
	insertRows(
		db,
		'platform_feedback',
		['id', 'submitter_user_id', 'status', 'updated_at'],
		ids.map((id) => [id, 'user-1', 'resolved', updatedAt]),
	)
}

function feedbackIds(count: number) {
	return Array.from(
		{ length: count },
		(_, index) => `feedback-${String(index).padStart(3, '0')}`,
	)
}

function insertAuditEvents(db: DatabaseSync, timestamps: Array<string>) {
	insertRows(
		db,
		'audit_events',
		['category', 'action', 'result', 'timestamp'],
		timestamps.map((timestamp) => ['auth', 'login', 'success', timestamp]),
	)
}

function retentionEnv(appDb: D1Database, auditDb = appDb) {
	return {
		APP_DB: appDb,
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<
		Env,
		'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'
	>
}

// Wraps a D1 facade so `run()` on the first statement matching `match`
// executes `beforeRun` first, simulating a racing writer.
function withRaceBeforeRun(
	base: D1Database,
	match: (query: string) => boolean,
	beforeRun: () => void,
) {
	return {
		prepare(query: string) {
			const prepared = base.prepare(query)
			if (!match(query)) return prepared
			return {
				bind(...params: Array<unknown>) {
					const bound = prepared.bind(...params)
					return {
						async run() {
							beforeRun()
							return bound.run()
						},
						all: bound.all,
						first: bound.first,
					}
				},
			}
		},
	} as unknown as D1Database
}

test('retention cron runs only on the hourly gate', () => {
	expect(shouldRunRetentionCron(new Date('2026-07-07T03:00:00.000Z'))).toBe(
		true,
	)
	expect(shouldRunRetentionCron(new Date('2026-07-07T03:05:00.000Z'))).toBe(
		false,
	)
})

test('platform feedback retention prunes terminal rows in bounded batches and runs round-robin', async () => {
	const { sqlite, db } = createRetentionDb()
	const days = platformFeedbackRetentionDays
	insertRows(
		sqlite,
		'platform_feedback',
		['id', 'submitter_user_id', 'status', 'updated_at'],
		[
			['terminal-old-resolved', 'user-1', 'resolved', daysAgo(days + 2)],
			['terminal-old-dismissed', 'user-1', 'dismissed', daysAgo(days + 1)],
			['terminal-boundary', 'user-1', 'resolved', daysAgo(days)],
			['active-old-open', 'user-1', 'open', daysAgo(days + 10)],
			['active-old-triaged', 'user-1', 'triaged', daysAgo(days + 10)],
		],
	)

	for (const expected of [1, 1, 0]) {
		expect(
			await prunePlatformFeedbackForRetention({ db, now, batchSize: 1 }),
		).toEqual({ selected: expected, deleted: expected })
	}
	const survivors = [
		'active-old-open',
		'active-old-triaged',
		'terminal-boundary',
	]
	expect(selectColumn(sqlite, 'platform_feedback', 'id')).toEqual(survivors)

	insertResolvedFeedback(sqlite, ['runner-delete'])
	const result = await pruneRetention({ env: retentionEnv(db), now })
	expect(result.platformFeedback).toBe(1)
	expect(result.agentPackageConversationUses).toBe(0)
	expect(result.batchesPerTable['platform_feedback']).toBe(1)
	expect(result.batchesPerTable['agent_package_conversation_uses']).toBe(1)
	expect(selectColumn(sqlite, 'platform_feedback', 'id')).toEqual(survivors)
})

test('memory suppression, audit, stripe webhook, and agent package use retention respect boundaries', async () => {
	const { sqlite, db } = createRetentionDb()
	const suppression = (
		id: string,
		lastSeenDays: number,
		expiresDays: number,
	) => {
		const lastSeenAt = daysAgo(lastSeenDays)
		return [
			'user-1',
			'conversation',
			id,
			lastSeenAt,
			lastSeenAt,
			daysAgo(expiresDays),
		]
	}
	const packageUse = (packageId: string, lastUsedDays: number) => {
		const lastUsedAt = daysAgo(lastUsedDays)
		return ['user-1', packageId, 'conversation', lastUsedAt, lastUsedAt]
	}
	insertRows(
		sqlite,
		'mcp_memory_conversation_suppressions',
		[
			'user_id',
			'conversation_id',
			'memory_id',
			'created_at',
			'last_seen_at',
			'expires_at',
		],
		[
			suppression('memory-old-expired', memorySuppressionRetentionDays + 1, 1),
			suppression('memory-boundary', memorySuppressionRetentionDays, 1),
			suppression('memory-active', memorySuppressionRetentionDays + 1, -1),
		],
	)
	insertAuditEvents(sqlite, [
		daysAgo(auditEventRetentionDays + 1),
		daysAgo(auditEventRetentionDays),
	])
	insertRows(
		sqlite,
		'stripe_webhook_events',
		['event_id', 'event_type', 'processed_at'],
		[
			[
				'evt_old',
				'checkout.session.completed',
				daysAgo(stripeWebhookEventRetentionDays + 1),
			],
			[
				'evt_boundary',
				'checkout.session.completed',
				daysAgo(stripeWebhookEventRetentionDays),
			],
		],
	)
	insertRows(
		sqlite,
		'agent_package_conversation_uses',
		[
			'user_id',
			'package_id',
			'conversation_id',
			'first_used_at',
			'last_used_at',
		],
		[
			packageUse('pkg-old', agentPackageConversationUseRetentionDays + 1),
			packageUse('pkg-boundary', agentPackageConversationUseRetentionDays),
			packageUse('pkg-recent', 1),
		],
	)

	for (const prune of [
		pruneMemorySuppressionsForRetention,
		pruneAuditEventsForRetention,
		pruneStripeWebhookEventsForRetention,
		pruneAgentPackageConversationUsesForRetention,
	]) {
		expect(await prune({ db, now })).toEqual({ selected: 1, deleted: 1 })
	}
	expect(
		selectColumn(sqlite, 'mcp_memory_conversation_suppressions', 'memory_id'),
	).toEqual(['memory-active', 'memory-boundary'])
	expect(selectColumn(sqlite, 'audit_events', 'timestamp')).toEqual([
		daysAgo(auditEventRetentionDays),
	])
	expect(selectColumn(sqlite, 'stripe_webhook_events', 'event_id')).toEqual([
		'evt_boundary',
	])
	expect(
		selectColumn(sqlite, 'agent_package_conversation_uses', 'package_id'),
	).toEqual(['pkg-boundary', 'pkg-recent'])
})

test('retention prune reports selected separately from deleted when rows vanish mid-batch', async () => {
	const { sqlite, db } = createRetentionDb()
	// Simulate a racing writer deleting one selected row before the batch
	// DELETE runs: selected stays at the full batch size so hasMore-style
	// decisions keep looping instead of marking the table drained.
	const dbWithVanishingRow = withRaceBeforeRun(
		db,
		(query) => query.includes('DELETE FROM platform_feedback'),
		() => {
			sqlite
				.prepare(`DELETE FROM platform_feedback WHERE id = 'feedback-000'`)
				.run()
		},
	)
	insertResolvedFeedback(sqlite, feedbackIds(2))

	expect(
		await prunePlatformFeedbackForRetention({
			db: dbWithVanishingRow,
			now,
			batchSize: 2,
		}),
	).toEqual({ selected: 2, deleted: 1 })
})

test('usage rollup and feature flag exposure retention respect month and day boundaries', async () => {
	const { sqlite, db } = createRetentionDb()
	// 24 months before 2026-07 keeps 2024-07 and later.
	insertRows(
		sqlite,
		'usage_rollups',
		['user_id', 'metric', 'month', 'event_count', 'updated_at'],
		['2024-06', '2024-07', '2026-06'].map((month) => [
			'user-1',
			'mcp_tool_call',
			month,
			1,
			now.toISOString(),
		]),
	)
	expect(await pruneUsageRollupsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(selectColumn(sqlite, 'usage_rollups', 'month')).toEqual([
		'2024-07',
		'2026-06',
	])

	const day = (days: number) => daysAgo(days).slice(0, 10)
	insertRows(
		sqlite,
		'feature_flag_exposure_rollups',
		[
			'flag_key',
			'user_id',
			'day',
			'enabled',
			'source',
			'exposure_count',
			'updated_at',
		],
		[
			day(featureFlagExposureRetentionDays + 1),
			day(featureFlagExposureRetentionDays),
			day(1),
		].map((value) => [
			'retired-flag',
			'user-1',
			value,
			1,
			'rollout',
			1,
			now.toISOString(),
		]),
	)
	expect(await pruneFeatureFlagExposuresForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(selectColumn(sqlite, 'feature_flag_exposure_rollups', 'day')).toEqual([
		day(featureFlagExposureRetentionDays),
		day(1),
	])
})

const entitySourceColumns = [
	'id',
	'user_id',
	'entity_kind',
	'entity_id',
	'repo_id',
	'published_commit',
	'created_at',
	'updated_at',
]
const artifactColumns = [
	'id',
	'user_id',
	'source_id',
	'published_commit',
	'artifact_kind',
	'entry_point',
	'kv_key',
	'created_at',
	'updated_at',
]

function entitySourceRow(sourceId: string, publishedCommit: string) {
	return [
		sourceId,
		'user-1',
		'package',
		`pkg-${sourceId}`,
		`repo-${sourceId}`,
		publishedCommit,
		daysAgo(60),
		daysAgo(60),
	]
}

function artifactRow(
	id: string,
	sourceId: string,
	commit: string,
	days: number,
) {
	const createdAt = daysAgo(days)
	return [
		id,
		'user-1',
		sourceId,
		commit,
		'module',
		'src/index.ts',
		`kv:${id}`,
		createdAt,
		createdAt,
	]
}

test('published bundle artifact retention deletes stale rows, KV blobs, and source snapshots', async () => {
	const { sqlite, db } = createRetentionDb()
	const kvDelete = vi.fn(async () => undefined)
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	await indexEnv.REPO_SESSION_INDEX.get(
		indexEnv.REPO_SESSION_INDEX.idFromName('user-1'),
	).insertSession({
		ownerId: ownerIdFromStored('user-1'),
		row: {
			id: 'session-1',
			user_id: ownerIdFromStored('user-1'),
			source_id: 'source-session',
			source_repo_id: 'repo-1',
			session_branch: 'sessions/session-1',
			source_branch: 'main',
			base_commit: 'commit',
			source_root: '/',
			conversation_id: null,
			status: 'active',
			expires_at: null,
			last_checkpoint_at: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			created_at: daysAgo(1),
			updated_at: daysAgo(1),
		} satisfies RepoSessionRow,
	})
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: { delete: kvDelete },
		REPO_SESSION_INDEX: indexEnv.REPO_SESSION_INDEX,
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'> & typeof indexEnv
	insertRows(
		sqlite,
		'entity_sources',
		entitySourceColumns,
		['source-current', 'source-stale', 'source-session'].map((id) =>
			entitySourceRow(id, 'commit-current'),
		),
	)
	const stale = publishedBundleArtifactRetentionDays + 1
	// Only an old artifact whose commit is no longer published and whose
	// source has no active repo session is stale.
	insertRows(sqlite, 'published_bundle_artifacts', artifactColumns, [
		artifactRow('artifact-delete', 'source-stale', 'commit-old', stale),
		artifactRow('artifact-current', 'source-current', 'commit-current', stale),
		artifactRow('artifact-fresh', 'source-stale', 'commit-old', stale - 1),
		artifactRow('artifact-session', 'source-session', 'commit-old', stale),
	])

	expect(
		await prunePublishedBundleArtifactsForRetention({
			env,
			now,
			batchSize: 10,
		}),
	).toEqual({
		deletedRows: 1,
		deletedKvKeys: 1,
		deletedSnapshotKvKeys: 4,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(kvDelete).toHaveBeenCalledWith('kv:artifact-delete')
	expect(kvDelete).toHaveBeenCalledWith(
		'source-snapshot:v1:source-stale:commit-old',
	)
	expect(kvDelete).toHaveBeenCalledWith(
		'source-manifest-snapshot:v1:source-stale:commit-old',
	)
	expect(kvDelete).toHaveBeenCalledWith(
		'credential-needs:v1:source-stale:commit-old',
	)
	expect(kvDelete).toHaveBeenCalledWith(
		'credential-stamp:v1:source-stale:commit-old',
	)
	expect(selectColumn(sqlite, 'published_bundle_artifacts', 'id')).toEqual([
		'artifact-current',
		'artifact-fresh',
		'artifact-session',
	])
})

test('published bundle retention keeps artifacts while entity_sources are soft-deleted', async () => {
	const { sqlite, db } = createRetentionDb()
	const kvDelete = vi.fn(async () => undefined)
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: { delete: kvDelete },
		REPO_SESSION_INDEX:
			createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	insertRows(sqlite, 'entity_sources', entitySourceColumns, [
		entitySourceRow('source-tombstone', 'commit-old'),
	])
	sqlite
		.prepare(
			`UPDATE entity_sources SET deleted_at = ? WHERE id = 'source-tombstone'`,
		)
		.run(daysAgo(1))
	insertRows(sqlite, 'published_bundle_artifacts', artifactColumns, [
		artifactRow(
			'artifact-restore-window',
			'source-tombstone',
			'commit-old',
			publishedBundleArtifactRetentionDays + 1,
		),
	])

	expect(
		await prunePublishedBundleArtifactsForRetention({
			env,
			now,
			batchSize: 10,
		}),
	).toEqual({
		deletedRows: 0,
		deletedKvKeys: 0,
		deletedSnapshotKvKeys: 0,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(kvDelete).not.toHaveBeenCalled()
	expect(selectColumn(sqlite, 'published_bundle_artifacts', 'id')).toEqual([
		'artifact-restore-window',
	])
})

test('published bundle artifact retention rechecks staleness before deleting selected rows', async () => {
	const { sqlite, db } = createRetentionDb()
	const kvDelete = vi.fn(async () => undefined)
	let refreshedBeforeDelete = false
	const dbWithRefreshRace = withRaceBeforeRun(
		db,
		(query) =>
			query.includes('DELETE FROM published_bundle_artifacts') &&
			query.includes('AND kv_key = ?'),
		() => {
			refreshedBeforeDelete = true
			sqlite
				.prepare(
					`UPDATE entity_sources SET published_commit = 'commit-old' WHERE id = 'source-race'`,
				)
				.run()
		},
	)
	const env = {
		APP_DB: dbWithRefreshRace,
		BUNDLE_ARTIFACTS_KV: { delete: kvDelete },
		REPO_SESSION_INDEX:
			createInMemoryRepoSessionIndexEnv(dbWithRefreshRace).REPO_SESSION_INDEX,
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	insertRows(sqlite, 'entity_sources', entitySourceColumns, [
		entitySourceRow('source-race', 'commit-current'),
	])
	insertRows(sqlite, 'published_bundle_artifacts', artifactColumns, [
		artifactRow(
			'artifact-race',
			'source-race',
			'commit-old',
			publishedBundleArtifactRetentionDays + 1,
		),
	])

	expect(
		await prunePublishedBundleArtifactsForRetention({
			env,
			now,
			batchSize: 10,
		}),
	).toEqual({
		deletedRows: 0,
		deletedKvKeys: 0,
		deletedSnapshotKvKeys: 0,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(refreshedBeforeDelete).toBe(true)
	expect(kvDelete).not.toHaveBeenCalled()
	expect(selectColumn(sqlite, 'published_bundle_artifacts', 'id')).toEqual([
		'artifact-race',
	])
})

test('retention pruning deletes one configured batch per table invocation and chunks ids under the D1 binding limit', async () => {
	const { sqlite } = createRetentionDb()
	const db = createD1FromSqlite(sqlite, { maxBindings: 100 })
	const old = (offset = 0) => daysAgo(auditEventRetentionDays + 1 + offset)
	insertAuditEvents(sqlite, [old(0), old(1), old(2)])
	expect(await pruneAuditEventsForRetention({ db, now, batchSize: 2 })).toEqual(
		{ selected: 2, deleted: 2 },
	)
	expect(selectColumn(sqlite, 'audit_events', 'timestamp')).toHaveLength(1)
	expect(await pruneAuditEventsForRetention({ db, now, batchSize: 2 })).toEqual(
		{ selected: 1, deleted: 1 },
	)
	expect(selectColumn(sqlite, 'audit_events', 'timestamp')).toEqual([])

	insertAuditEvents(
		sqlite,
		Array.from({ length: 101 }, () => old()),
	)
	expect(
		await pruneAuditEventsForRetention({ db, now, batchSize: 101 }),
	).toEqual({ selected: 101, deleted: 101 })
	expect(selectColumn(sqlite, 'audit_events', 'timestamp')).toEqual([])
})

test('retention run loops batches per table until backlogs are drained', async () => {
	const app = createRetentionDb()
	const audit = createRetentionDb()
	insertResolvedFeedback(app.sqlite, feedbackIds(501))
	insertAuditEvents(
		audit.sqlite,
		Array.from({ length: 300 }, () => daysAgo(auditEventRetentionDays + 1)),
	)

	const result = await pruneRetention({
		env: retentionEnv(app.db, audit.db),
		now,
	})

	expect(result.platformFeedback).toBe(501)
	expect(result.auditEvents).toBe(300)
	expect(result.batchesPerTable['platform_feedback']).toBe(3)
	expect(result.batchesPerTable['audit_events']).toBe(2)
	expect(result.timeBudgetExhausted).toBe(false)
	expect(selectColumn(app.sqlite, 'platform_feedback', 'id')).toEqual([])
	expect(selectColumn(audit.sqlite, 'audit_events', 'id')).toEqual([])
})

test('retention run gives every table one batch and stops when the budget is exhausted', async () => {
	const { sqlite, db } = createRetentionDb()
	insertResolvedFeedback(sqlite, feedbackIds(300))
	insertAuditEvents(sqlite, [daysAgo(auditEventRetentionDays + 1)])

	const result = await pruneRetention({
		env: retentionEnv(db),
		now,
		timeBudgetMs: 0,
	})

	// The first round-robin pass always completes so a hot table cannot starve
	// the others, then the exhausted budget stops further passes.
	expect(result.platformFeedback).toBe(250)
	expect(result.auditEvents).toBe(1)
	expect(result.batchesPerTable['platform_feedback']).toBe(1)
	expect(result.timeBudgetExhausted).toBe(true)
	expect(selectColumn(sqlite, 'platform_feedback', 'id')).toHaveLength(50)
})

test('retention coverage includes every live growth-pattern table or documented exemption', () => {
	const db = new DatabaseSync(':memory:')
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))
	const tables = db
		.prepare(
			`SELECT name
			FROM sqlite_schema
			WHERE type = 'table'
				AND name NOT LIKE 'sqlite_%'
			ORDER BY name`,
		)
		.all() as Array<{ name: string }>
	const candidateTables = new Set<string>()
	const growthPattern =
		/(?:_runs|_logs|_events|_invocations|_suppressions|_artifacts|_messages|_threads|_attachments|_rollups|_counters|_memories)$/u
	const growthTimeColumns = ['created_at', 'day', 'month']
	for (const table of tables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
			.all() as Array<{ name: string }>
		const columnNames = new Set(columns.map((column) => column.name))
		const hasUserCreatedGrowthShape =
			columnNames.has('user_id') &&
			growthTimeColumns.some((column) => columnNames.has(column)) &&
			growthPattern.test(table.name)
		const hasGlobalStripeWebhookShape =
			table.name === 'stripe_webhook_events' && columnNames.has('processed_at')
		const hasPlatformFeedbackGrowthShape =
			table.name === 'platform_feedback' &&
			columnNames.has('submitter_user_id') &&
			columnNames.has('updated_at')
		const hasAgentPackageConversationUsesGrowthShape =
			table.name === 'agent_package_conversation_uses' &&
			columnNames.has('user_id') &&
			columnNames.has('last_used_at')
		if (
			hasUserCreatedGrowthShape ||
			hasGlobalStripeWebhookShape ||
			hasPlatformFeedbackGrowthShape ||
			hasAgentPackageConversationUsesGrowthShape
		) {
			candidateTables.add(table.name)
		}
	}
	const covered = getRetentionPolicyCoverage()
	const missing = [...candidateTables].filter((table) => !covered.has(table))
	const stale = [...covered].filter(
		(table) =>
			!candidateTables.has(table) && !tables.some((row) => row.name === table),
	)

	expect(missing).toEqual([])
	expect(stale).toEqual([])
})
