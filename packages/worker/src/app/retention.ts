/**
 * soft-delete-read-filter: opt-out
 *
 * Published-bundle retention must treat soft-deleted entity_sources as still
 * present so restore-window artifacts are not pruned before hard purge.
 */
import { purgeProfiles } from '#worker/profiles/store.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { accountRetentionDispositions } from '#app/account-retention-dispositions.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { agentPackagePopularityMaxAgeDays } from '#worker/usage/agent-package-conversation-uses.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedCredentialNeedsKvKey,
	buildPublishedCredentialStampKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { hasActiveRepoSessionForSource } from '#worker/repo/repo-sessions.ts'
import { type RepoSessionIndexEnv } from '#worker/repo/repo-session-index-client.ts'

type RetentionPolicy = {
	table: string
	scope: 'per-user' | 'global'
	retentionDays?: number
	maxRowsPerPartition?: number
	batchSize: number
	description: string
}

type RetentionPolicyExemption = {
	table: string
	reason: string
}

type IdValue = string | number

export {
	retentionCronGateMinutes,
	retentionCronIntervalMinutes,
	shouldRunRetentionCron,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
export const retentionDefaultBatchSize = 250
export const retentionDeleteIdsMaxParameters = 100
export const publishedBundleArtifactRetentionBatchSize = 100
/**
 * Total wall-clock budget for one retention cron run. Each hourly run keeps
 * deleting batches (round-robin across tables) until every table is drained
 * or this budget is exhausted, so backlogs shrink instead of only losing one
 * batch per table per hour.
 */
export const retentionRunTimeBudgetMs = 20_000

export const memorySuppressionRetentionDays = 90
export const platformFeedbackRetentionDays = 365
export const publishedBundleArtifactRetentionDays = 30
export const usageRollupRetentionMonths = 24
export const featureFlagExposureRetentionDays = 90
export const auditEventRetentionDays = 180
export const stripeWebhookEventRetentionDays = 30
export const agentPackageConversationUseRetentionDays =
	agentPackagePopularityMaxAgeDays

const millisecondsPerDay = 24 * 60 * 60 * 1000

/**
 * Inventory of D1 growth-table retention policies. Keep this manifest in sync
 * with the scheduled prune implementation and data-storage.md so future growth
 * tables have an explicit retention story or a documented exemption.
 *
 * Explicit policy / alternate_cleanup / durable_forever dispositions also live
 * in `account-retention-dispositions.ts` and must cover the same table set
 * (`account-retention-dispositions.node.test.ts`). The schema-growth heuristic
 * in `retention.node.test.ts` remains a second net for discovering new tables.
 */
export const retentionPolicies: ReadonlyArray<RetentionPolicy> = [
	{
		table: 'mcp_memory_conversation_suppressions',
		scope: 'per-user',
		retentionDays: memorySuppressionRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Conversation suppression rows are kept while active and for up to 90 days since last seen.',
	},
	{
		table: 'platform_feedback',
		scope: 'per-user',
		retentionDays: platformFeedbackRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Resolved and dismissed platform feedback is pruned 365 days after its last update; open and triaged feedback remains until resolved, dismissed, or submitter deletion.',
	},
	{
		table: 'published_bundle_artifacts',
		scope: 'per-user',
		retentionDays: publishedBundleArtifactRetentionDays,
		batchSize: publishedBundleArtifactRetentionBatchSize,
		description:
			'Published bundle rows, KV blobs, and the matching source snapshot KV keys are deleted only when older than 30 days, not current for any source, and not tied to an active repo session.',
	},
	{
		table: 'usage_rollups',
		scope: 'per-user',
		batchSize: retentionDefaultBatchSize,
		description:
			'Per user/metric/month usage rollups keep 24 months; Analytics Engine retains the raw event stream separately.',
	},
	{
		table: 'feature_flag_exposure_rollups',
		scope: 'per-user',
		retentionDays: featureFlagExposureRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Local-dev/test flag exposure rollups keep 90 days, matching Analytics Engine retention for the production exposure stream; the metric readout window is the current month.',
	},
	{
		table: 'stripe_webhook_events',
		scope: 'global',
		retentionDays: stripeWebhookEventRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Stripe platform webhook idempotency rows keep 30 days by processed_at and are independent of account deletion.',
	},
	{
		table: 'agent_package_conversation_uses',
		scope: 'per-user',
		retentionDays: agentPackageConversationUseRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Agent package conversation-use rows keep 180 days by last_used_at, matching the query-time popularity window.',
	},
] as const

export const retentionPolicyExemptions: ReadonlyArray<RetentionPolicyExemption> =
	accountRetentionDispositions
		.filter(
			(
				disposition,
			): disposition is Extract<
				(typeof accountRetentionDispositions)[number],
				{ kind: 'alternate_cleanup' | 'durable_forever' }
			> =>
				disposition.kind === 'alternate_cleanup' ||
				disposition.kind === 'durable_forever',
		)
		.map((disposition) => ({
			table: disposition.table,
			reason: disposition.reason,
		}))

export type RetentionPruneResult = {
	memorySuppressions: number
	platformFeedback: number
	publishedBundleArtifacts: {
		deletedRows: number
		deletedKvKeys: number
		deletedSnapshotKvKeys: number
		kvDeleteErrors: number
	}
	usageRollups: number
	featureFlagExposureRollups: number
	auditEvents: number
	stripeWebhookEvents: number
	agentPackageConversationUses: number
	/** Revoked or expired profiles past their purge window, plus their grants. */
	profiles: number
	batchesPerTable: Record<string, number>
	timeBudgetExhausted: boolean
}

export function getRetentionPolicyCoverage() {
	const covered = new Set<string>()
	for (const policy of retentionPolicies) {
		covered.add(policy.table)
	}
	for (const exemption of retentionPolicyExemptions) {
		covered.add(exemption.table)
	}
	return covered
}

function cutoffIso(now: Date, days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function cutoffMonth(now: Date, months: number) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
		.toISOString()
		.slice(0, 'YYYY-MM'.length)
}

function placeholders(values: ReadonlyArray<unknown>) {
	return values.map(() => '?').join(', ')
}

async function selectIds(input: {
	db: D1Database
	sql: string
	bindings: ReadonlyArray<string | number>
	column?: string
}): Promise<Array<IdValue>> {
	const column = input.column ?? 'id'
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(input.sql)
			.bind(...input.bindings)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => row[column] as IdValue)
}

/**
 * Runs a batched select-then-delete and reports both counts. `selected` (not
 * `deleted`) is what callers should feed into hasMore decisions: a full batch
 * that deletes fewer rows (racing writers) must not mark a table drained.
 */
async function selectAndDeleteByIds(input: {
	db: D1Database
	sql: string
	bindings: ReadonlyArray<string | number>
	column?: string
	table: string
	idColumn: string
}): Promise<{ selected: number; deleted: number }> {
	const ids = await selectIds(input)
	const deleted = await deleteByIds({
		db: input.db,
		table: input.table,
		idColumn: input.idColumn,
		ids,
	})
	return { selected: ids.length, deleted }
}

async function deleteByIds(input: {
	db: D1Database
	table: string
	idColumn: string
	ids: ReadonlyArray<IdValue>
}) {
	if (input.ids.length === 0) return 0
	let deleted = 0
	for (
		let index = 0;
		index < input.ids.length;
		index += retentionDeleteIdsMaxParameters
	) {
		const ids = input.ids.slice(index, index + retentionDeleteIdsMaxParameters)
		const result = await runD1WithRetry(() =>
			input.db
				.prepare(
					`DELETE FROM ${input.table}
				WHERE ${input.idColumn} IN (${placeholders(ids)})`,
				)
				.bind(...ids)
				.run(),
		)
		deleted += result.meta.changes ?? 0
	}
	return deleted
}

async function deletePublishedBundleArtifactRowIfStillStale(input: {
	env: Pick<Env, 'APP_DB'> & RepoSessionIndexEnv
	id: string
	kvKey: string
	cutoff: string
	userId: OwnerId
	sourceId: string
}) {
	if (
		await hasActiveRepoSessionForSource(input.env, {
			userId: input.userId,
			sourceId: input.sourceId,
		})
	) {
		return 0
	}
	const result = await runD1WithRetry(() =>
		input.env.APP_DB.prepare(
			`DELETE FROM published_bundle_artifacts
			WHERE id = ?
				AND kv_key = ?
				AND created_at < ?
				AND NOT EXISTS (
					SELECT 1
					FROM entity_sources AS source
					WHERE source.user_id = published_bundle_artifacts.user_id
						AND source.id = published_bundle_artifacts.source_id
						AND source.published_commit = published_bundle_artifacts.published_commit
				)`,
		)
			.bind(input.id, input.kvKey, input.cutoff)
			.run(),
	)
	return result.meta.changes ?? 0
}

export async function pruneMemorySuppressionsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = cutoffIso(now, memorySuppressionRetentionDays)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [
			now.toISOString(),
			cutoff,
			input.batchSize ?? retentionDefaultBatchSize,
		],
		sql: `SELECT rowid
			FROM mcp_memory_conversation_suppressions
			WHERE expires_at <= ?
				AND last_seen_at < ?
			ORDER BY last_seen_at ASC, rowid ASC
			LIMIT ?`,
		table: 'mcp_memory_conversation_suppressions',
		idColumn: 'rowid',
	})
}

export async function prunePlatformFeedbackForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		platformFeedbackRetentionDays,
	)
	const ids = await selectIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM platform_feedback
			WHERE status IN ('resolved', 'dismissed')
				AND updated_at < ?
			ORDER BY updated_at ASC, id ASC
			LIMIT ?`,
	})
	let deleted = 0
	const chunkSize = retentionDeleteIdsMaxParameters - 1
	for (let index = 0; index < ids.length; index += chunkSize) {
		const chunk = ids.slice(index, index + chunkSize)
		const result = await runD1WithRetry(() =>
			input.db
				.prepare(
					`DELETE FROM platform_feedback
					WHERE id IN (${placeholders(chunk)})
						AND status IN ('resolved', 'dismissed')
						AND updated_at < ?`,
				)
				.bind(...chunk, cutoff)
				.run(),
		)
		deleted += result.meta.changes ?? 0
	}
	return { selected: ids.length, deleted }
}

export async function prunePublishedBundleArtifactsForRetention(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'> & RepoSessionIndexEnv
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		publishedBundleArtifactRetentionDays,
	)
	const batchSize = input.batchSize ?? publishedBundleArtifactRetentionBatchSize
	const { results } = await runD1WithRetry(() =>
		input.env.APP_DB.prepare(
			`SELECT artifact.id, artifact.kv_key, artifact.source_id, artifact.user_id, artifact.published_commit
		FROM published_bundle_artifacts AS artifact
		WHERE artifact.created_at < ?
			AND NOT EXISTS (
				SELECT 1
				FROM entity_sources AS source
				WHERE source.user_id = artifact.user_id
					AND source.id = artifact.source_id
					AND source.published_commit = artifact.published_commit
			)
		ORDER BY artifact.created_at ASC, artifact.id ASC LIMIT ?`,
		)
			.bind(cutoff, batchSize)
			.all<{
				id: string
				kv_key: string
				source_id: string
				user_id: OwnerId
				published_commit: string
			}>(),
	)
	const rows = results ?? []
	let deletedRows = 0
	let deletedKvKeys = 0
	let deletedSnapshotKvKeys = 0
	let kvDeleteErrors = 0
	const prunedSnapshotPairs = new Map<
		string,
		{ sourceId: string; publishedCommit: string }
	>()
	for (const row of rows) {
		const rowDeleted = await deletePublishedBundleArtifactRowIfStillStale({
			env: input.env,
			id: row.id,
			kvKey: row.kv_key,
			cutoff,
			userId: row.user_id,
			sourceId: row.source_id,
		})
		if (rowDeleted === 0) continue
		deletedRows += rowDeleted
		prunedSnapshotPairs.set(`${row.source_id}:${row.published_commit}`, {
			sourceId: row.source_id,
			publishedCommit: row.published_commit,
		})
		try {
			await input.env.BUNDLE_ARTIFACTS_KV.delete(row.kv_key)
			deletedKvKeys += 1
		} catch (error) {
			kvDeleteErrors += 1
			console.warn('retention-published-bundle-kv-delete-failed', {
				id: row.id,
				kvKey: row.kv_key,
				error,
			})
		}
	}
	// A pruned row already satisfied the safety conditions (commit not current
	// for any entity_sources row, no active repo session), so the source
	// snapshot KV keys for that commit are stale too.
	for (const pair of prunedSnapshotPairs.values()) {
		for (const kvKey of [
			buildPublishedSourceSnapshotKvKey(pair),
			buildPublishedSourceManifestSnapshotKvKey(pair),
			buildPublishedCredentialNeedsKvKey(pair),
			buildPublishedCredentialStampKvKey(pair),
		]) {
			try {
				await input.env.BUNDLE_ARTIFACTS_KV.delete(kvKey)
				deletedSnapshotKvKeys += 1
			} catch (error) {
				kvDeleteErrors += 1
				console.warn('retention-source-snapshot-kv-delete-failed', {
					sourceId: pair.sourceId,
					publishedCommit: pair.publishedCommit,
					kvKey,
					error,
				})
			}
		}
	}
	return {
		deletedRows,
		deletedKvKeys,
		deletedSnapshotKvKeys,
		kvDeleteErrors,
		hasMore: rows.length >= batchSize,
	}
}

export async function pruneUsageRollupsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const oldestKeptMonth = cutoffMonth(
		input.now ?? new Date(),
		usageRollupRetentionMonths,
	)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [oldestKeptMonth, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT rowid
			FROM usage_rollups
			WHERE month < ?
			ORDER BY month ASC, rowid ASC
			LIMIT ?`,
		table: 'usage_rollups',
		idColumn: 'rowid',
	})
}

export async function pruneFeatureFlagExposuresForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoffDay = cutoffIso(
		input.now ?? new Date(),
		featureFlagExposureRetentionDays,
	).slice(0, 'YYYY-MM-DD'.length)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [cutoffDay, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT rowid
			FROM feature_flag_exposure_rollups
			WHERE day < ?
			ORDER BY day ASC, rowid ASC
			LIMIT ?`,
		table: 'feature_flag_exposure_rollups',
		idColumn: 'rowid',
	})
}

export async function pruneAuditEventsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(input.now ?? new Date(), auditEventRetentionDays)
	return selectAndDeleteByIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM audit_events
			WHERE timestamp < ?
			ORDER BY timestamp ASC, id ASC
			LIMIT ?`,
		table: 'audit_events',
		idColumn: 'id',
	})
}

export async function pruneStripeWebhookEventsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		stripeWebhookEventRetentionDays,
	)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'event_id',
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT event_id
			FROM stripe_webhook_events
			WHERE processed_at < ?
			ORDER BY processed_at ASC, event_id ASC
			LIMIT ?`,
		table: 'stripe_webhook_events',
		idColumn: 'event_id',
	})
}

export async function pruneAgentPackageConversationUsesForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		agentPackageConversationUseRetentionDays,
	)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT rowid
			FROM agent_package_conversation_uses
			WHERE last_used_at < ?
			ORDER BY last_used_at ASC, rowid ASC
			LIMIT ?`,
		table: 'agent_package_conversation_uses',
		idColumn: 'rowid',
	})
}

export async function pruneRetention(input: {
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV'>
	now?: Date
	timeBudgetMs?: number
}): Promise<RetentionPruneResult> {
	const now = input.now ?? new Date()
	const timeBudgetMs = input.timeBudgetMs ?? retentionRunTimeBudgetMs
	const startedAtMs = Date.now()
	const db = input.env.APP_DB
	const auditDb = input.env.AUDIT_DB
	const result: RetentionPruneResult = {
		memorySuppressions: 0,
		platformFeedback: 0,
		publishedBundleArtifacts: {
			deletedRows: 0,
			deletedKvKeys: 0,
			deletedSnapshotKvKeys: 0,
			kvDeleteErrors: 0,
		},
		usageRollups: 0,
		featureFlagExposureRollups: 0,
		auditEvents: 0,
		stripeWebhookEvents: 0,
		agentPackageConversationUses: 0,
		profiles: 0,
		batchesPerTable: {},
		timeBudgetExhausted: false,
	}
	const countTask = (
		table: string,
		prune: () => Promise<{ selected: number; deleted: number }>,
		assign: (deleted: number) => void,
	) => ({
		table,
		done: false,
		run: async () => {
			const batch = await prune()
			assign(batch.deleted)
			// hasMore keys off the selected count so a full batch that deleted
			// fewer rows (racing writers) does not mark the table drained early.
			return batch.selected >= retentionDefaultBatchSize
		},
	})
	const tasks: Array<{
		table: string
		done: boolean
		run: () => Promise<boolean>
	}> = [
		countTask(
			'mcp_memory_conversation_suppressions',
			() => pruneMemorySuppressionsForRetention({ db, now }),
			(count) => {
				result.memorySuppressions += count
			},
		),
		countTask(
			'platform_feedback',
			() => prunePlatformFeedbackForRetention({ db, now }),
			(count) => {
				result.platformFeedback += count
			},
		),
		{
			table: 'published_bundle_artifacts',
			done: false,
			run: async () => {
				const batch = await prunePublishedBundleArtifactsForRetention({
					env: input.env,
					now,
				})
				result.publishedBundleArtifacts.deletedRows += batch.deletedRows
				result.publishedBundleArtifacts.deletedKvKeys += batch.deletedKvKeys
				result.publishedBundleArtifacts.deletedSnapshotKvKeys +=
					batch.deletedSnapshotKvKeys
				result.publishedBundleArtifacts.kvDeleteErrors += batch.kvDeleteErrors
				return batch.hasMore
			},
		},
		countTask(
			'usage_rollups',
			() => pruneUsageRollupsForRetention({ db, now }),
			(count) => {
				result.usageRollups += count
			},
		),
		countTask(
			'feature_flag_exposure_rollups',
			() => pruneFeatureFlagExposuresForRetention({ db, now }),
			(count) => {
				result.featureFlagExposureRollups += count
			},
		),
		countTask(
			'audit_events',
			() => pruneAuditEventsForRetention({ db: auditDb, now }),
			(count) => {
				result.auditEvents += count
			},
		),
		countTask(
			'stripe_webhook_events',
			() => pruneStripeWebhookEventsForRetention({ db, now }),
			(count) => {
				result.stripeWebhookEvents += count
			},
		),
		countTask(
			'agent_package_conversation_uses',
			() => pruneAgentPackageConversationUsesForRetention({ db, now }),
			(count) => {
				result.agentPackageConversationUses += count
			},
		),
		{
			table: 'profiles',
			done: false,
			run: async () => {
				const purged = await purgeProfiles(db, { now })
				result.profiles += purged.profiles
				return false
			},
		},
	]
	// Round-robin passes: every pending table gets one batch before any table
	// gets a second one, so a hot table cannot starve the others. The first
	// pass always completes so each table makes progress every run; later
	// passes stop once the time budget is exhausted.
	let pass = 0
	while (tasks.some((task) => !task.done)) {
		if (pass > 0 && Date.now() - startedAtMs >= timeBudgetMs) {
			result.timeBudgetExhausted = true
			break
		}
		for (const task of tasks) {
			if (task.done) continue
			if (pass > 0 && Date.now() - startedAtMs >= timeBudgetMs) break
			const hasMore = await task.run()
			result.batchesPerTable[task.table] =
				(result.batchesPerTable[task.table] ?? 0) + 1
			if (!hasMore) task.done = true
		}
		pass += 1
	}
	console.info('retention-prune', JSON.stringify(result))
	return result
}
