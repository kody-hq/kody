/**
 * soft-delete-read-filter: opt-out
 *
 * Published-bundle retention must treat soft-deleted entity_sources as still
 * present so restore-window artifacts are not pruned before hard purge.
 */
import { Effect, Option, Schema } from 'effect'
import {
	D1,
	type Bound,
	type DatabaseError,
	makeD1,
	retryTransientD1,
	sql,
} from '#worker/effect/d1.ts'
import { startPassBudget } from '#worker/effect/budget.ts'
import { outbound, type OutboundCallError } from '#worker/effect/outbound.ts'
import { runD1Promise, runSlicePromise } from '#worker/effect/slice.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { purgeProfiles } from '#worker/profiles/store.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { accountRetentionDispositions } from '#app/account-retention-dispositions.ts'
import {
	localReadEventRetentionDays,
	pruneLocalReadEvents,
} from '#worker/credentials/local-read-store.ts'
import {
	pruneRawSigningEvents,
	rawSigningEventRetentionDays,
} from '#worker/credentials/raw-signing-store.ts'
import { agentPackagePopularityMaxAgeDays } from '#worker/usage/agent-package-conversation-uses.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedCredentialNeedsKvKey,
	buildPublishedCredentialStampKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	deleteLinkedArtifactGroups,
	linkedArtifactCommitKvPrefix,
} from '#worker/package-runtime/linked-artifact-store.ts'
import { hasActiveRepoSessionForSource } from '#worker/repo/repo-sessions.ts'
import type { RepoSessionIndexEnv } from '#worker/repo/repo-session-index-client.ts'

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
		table: 'credential_local_read_events',
		scope: 'global',
		retentionDays: localReadEventRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Local reads of a secret by the Kody CLI (with the real IP) keep 90 days; the last local read time on the secret is kept for good.',
	},
	{
		table: 'credential_raw_signing_events',
		scope: 'global',
		retentionDays: rawSigningEventRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Raw RSA signatures made with a signing credential keep 90 days; the last raw signature time on the credential is kept for good.',
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
	credentialLocalReadEvents: number
	credentialRawSigningEvents: number
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

type D1Service = D1['Service']

const today = (now: Date | undefined) => (now ? now : new Date())

/** Selects one batch of ids to prune, in the policy's age order. */
const selectIds = Effect.fn('Retention.selectIds')(function* (
	db: D1Service,
	operation: string,
	statement: { sql: string; bindings: ReadonlyArray<Bound>; column?: string },
) {
	const column = statement.column ?? 'id'
	const rows = yield* retryTransientD1(
		db.all(
			operation,
			Schema.Struct({ [column]: Schema.Union([Schema.String, Schema.Number]) }),
			sql(statement.sql, ...statement.bindings),
		),
	)
	return rows.map((row) => row[column] as IdValue)
})

/** Deletes ids in chunks of `retentionDeleteIdsMaxParameters`. */
const deleteByIds = Effect.fn('Retention.deleteByIds')(function* (
	db: D1Service,
	table: string,
	idColumn: string,
	ids: ReadonlyArray<IdValue>,
) {
	let deleted = 0
	for (
		let index = 0;
		index < ids.length;
		index += retentionDeleteIdsMaxParameters
	) {
		const chunk = ids.slice(index, index + retentionDeleteIdsMaxParameters)
		const result = yield* retryTransientD1(
			db.run(
				`retention.delete.${table}`,
				sql(
					`DELETE FROM ${table}
				WHERE ${idColumn} IN (${placeholders(chunk)})`,
					...chunk,
				),
			),
		)
		deleted += result.changes
	}
	return deleted
})

/**
 * Runs a batched select-then-delete and reports both counts. `selected` (not
 * `deleted`) is what callers should feed into hasMore decisions: a full batch
 * that deletes fewer rows (racing writers) must not mark a table drained.
 */
const selectAndDeleteByIds = Effect.fn('Retention.selectAndDeleteByIds')(
	function* (
		db: D1Service,
		input: {
			sql: string
			bindings: ReadonlyArray<Bound>
			column?: string
			table: string
			idColumn: string
		},
	) {
		const ids = yield* selectIds(db, `retention.select.${input.table}`, input)
		const deleted = yield* deleteByIds(db, input.table, input.idColumn, ids)
		return { selected: ids.length, deleted }
	},
)

type BatchOptions = { readonly now?: Date; readonly batchSize?: number }

export const pruneMemorySuppressionsForRetentionEffect = Effect.fn(
	'Retention.pruneMemorySuppressions',
)(function* (db: D1Service, options: BatchOptions) {
	const now = today(options.now)
	return yield* selectAndDeleteByIds(db, {
		column: 'rowid',
		bindings: [
			now.toISOString(),
			cutoffIso(now, memorySuppressionRetentionDays),
			options.batchSize ?? retentionDefaultBatchSize,
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
})

export const prunePlatformFeedbackForRetentionEffect = Effect.fn(
	'Retention.prunePlatformFeedback',
)(function* (db: D1Service, options: BatchOptions) {
	const cutoff = cutoffIso(today(options.now), platformFeedbackRetentionDays)
	const ids = yield* selectIds(db, 'retention.select.platform_feedback', {
		bindings: [cutoff, options.batchSize ?? retentionDefaultBatchSize],
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
		const result = yield* retryTransientD1(
			db.run(
				'retention.delete.platform_feedback',
				sql(
					`DELETE FROM platform_feedback
					WHERE id IN (${placeholders(chunk)})
						AND status IN ('resolved', 'dismissed')
						AND updated_at < ?`,
					...chunk,
					cutoff,
				),
			),
		)
		deleted += result.changes
	}
	return { selected: ids.length, deleted }
})

const StaleArtifactRow = Schema.Struct({
	id: Schema.String,
	kv_key: Schema.String,
	source_id: Schema.String,
	user_id: Schema.String,
	published_commit: Schema.String,
})
const AnyRow = Schema.Record(Schema.String, Schema.Unknown)

type ArtifactEnv = Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'> &
	RepoSessionIndexEnv

/** Deletes the row only if it is still stale and no repo session holds its source. */
const deletePublishedBundleArtifactRowIfStillStale = Effect.fn(
	'Retention.deletePublishedBundleArtifactRow',
)(function* (
	env: ArtifactEnv,
	db: D1Service,
	row: typeof StaleArtifactRow.Type,
	cutoff: string,
) {
	const active = yield* outbound('repo_sessions.hasActiveForSource', () =>
		hasActiveRepoSessionForSource(env, {
			userId: row.user_id as OwnerId,
			sourceId: row.source_id,
		}),
	)
	if (active) return 0
	const result = yield* retryTransientD1(
		db.run(
			'retention.delete.published_bundle_artifact',
			sql(
				`DELETE FROM published_bundle_artifacts
			WHERE id = ?
				AND kv_key = ?
				AND created_at < ?
				AND NOT EXISTS (
					SELECT 1
					FROM entity_sources AS source
					WHERE source.user_id = published_bundle_artifacts.user_id
						AND source.id = published_bundle_artifacts.source_id
						AND published_bundle_artifacts.published_commit IN (
							source.published_commit,
							source.serving_commit
						)
				)
				AND NOT EXISTS (
					SELECT 1
					FROM community_listings AS listing
					WHERE listing.source_id = published_bundle_artifacts.source_id
						AND listing.pinned_commit = published_bundle_artifacts.published_commit
						AND listing.status = 'active'
				)`,
				row.id,
				row.kv_key,
				cutoff,
			),
		),
	)
	return result.changes
})

export const prunePublishedBundleArtifactsForRetentionEffect = Effect.fn(
	'Retention.prunePublishedBundleArtifacts',
)(function* (env: ArtifactEnv, db: D1Service, options: BatchOptions) {
	const cutoff = cutoffIso(
		today(options.now),
		publishedBundleArtifactRetentionDays,
	)
	const batchSize =
		options.batchSize ?? publishedBundleArtifactRetentionBatchSize
	const kv = env.BUNDLE_ARTIFACTS_KV
	const rows = yield* retryTransientD1(
		db.all(
			'retention.select.published_bundle_artifacts',
			StaleArtifactRow,
			sql(
				`SELECT artifact.id, artifact.kv_key, artifact.source_id, artifact.user_id, artifact.published_commit
		FROM published_bundle_artifacts AS artifact
		WHERE artifact.created_at < ?
			AND NOT EXISTS (
				SELECT 1
				FROM entity_sources AS source
				WHERE source.user_id = artifact.user_id
					AND source.id = artifact.source_id
					AND artifact.published_commit IN (
						source.published_commit,
						source.serving_commit
					)
			)
			AND NOT EXISTS (
				SELECT 1
				FROM community_listings AS listing
				WHERE listing.source_id = artifact.source_id
					AND listing.pinned_commit = artifact.published_commit
					AND listing.status = 'active'
			)
		ORDER BY artifact.created_at ASC, artifact.id ASC LIMIT ?`,
				cutoff,
				batchSize,
			),
		),
	)
	let deletedRows = 0
	let deletedKvKeys = 0
	let deletedSnapshotKvKeys = 0
	let kvDeleteErrors = 0
	const kvFailed = (message: string, details: Record<string, unknown>) =>
		Effect.logWarning(message, details).pipe(
			Effect.andThen(Effect.sync(() => (kvDeleteErrors += 1))),
		)
	const prunedSnapshotPairs = new Map<
		string,
		{ sourceId: string; publishedCommit: string }
	>()
	for (const row of rows) {
		const rowDeleted = yield* deletePublishedBundleArtifactRowIfStillStale(
			env,
			db,
			row,
			cutoff,
		)
		if (rowDeleted === 0) continue
		deletedRows += rowDeleted
		prunedSnapshotPairs.set(`${row.source_id}:${row.published_commit}`, {
			sourceId: row.source_id,
			publishedCommit: row.published_commit,
		})
		yield* outbound('kv.delete', () => kv.delete(row.kv_key)).pipe(
			Effect.matchEffect({
				onSuccess: () => Effect.sync(() => (deletedKvKeys += 1)),
				onFailure: (error) =>
					kvFailed('retention-published-bundle-kv-delete-failed', {
						id: row.id,
						kvKey: row.kv_key,
						error: error.cause,
					}),
			}),
		)
	}
	// A pruned row already satisfied the safety conditions (commit neither
	// published nor serving for any entity_sources row, not pinned by an active
	// community listing, no active repo session), so the source snapshot KV
	// keys for that commit are stale too.
	for (const pair of prunedSnapshotPairs.values()) {
		// A newer artifact of this commit may remain and still reads its
		// linked modules, so they go only with the commit's last artifact.
		yield* retryTransientD1(
			db.first(
				'retention.select.remaining_commit_artifact',
				AnyRow,
				sql(
					`SELECT 1 FROM published_bundle_artifacts
					WHERE source_id = ? AND published_commit = ? LIMIT 1`,
					pair.sourceId,
					pair.publishedCommit,
				),
			),
		).pipe(
			Effect.flatMap((remaining) =>
				Option.isSome(remaining)
					? Effect.void
					: outbound('kv.deleteLinkedArtifactGroups', () =>
							deleteLinkedArtifactGroups({
								kv,
								prefix: linkedArtifactCommitKvPrefix(pair),
							}),
						).pipe(
							Effect.map((deleted) => {
								deletedSnapshotKvKeys += deleted
							}),
						),
			),
			Effect.catch((error) =>
				kvFailed('retention-linked-artifact-kv-delete-failed', {
					sourceId: pair.sourceId,
					publishedCommit: pair.publishedCommit,
					error: error.cause,
				}),
			),
		)
		for (const kvKey of [
			buildPublishedSourceSnapshotKvKey(pair),
			buildPublishedSourceManifestSnapshotKvKey(pair),
			buildPublishedCredentialNeedsKvKey(pair),
			buildPublishedCredentialStampKvKey(pair),
		]) {
			yield* outbound('kv.delete', () => kv.delete(kvKey)).pipe(
				Effect.matchEffect({
					onSuccess: () => Effect.sync(() => (deletedSnapshotKvKeys += 1)),
					onFailure: (error) =>
						kvFailed('retention-source-snapshot-kv-delete-failed', {
							sourceId: pair.sourceId,
							publishedCommit: pair.publishedCommit,
							kvKey,
							error: error.cause,
						}),
				}),
			)
		}
	}
	return {
		deletedRows,
		deletedKvKeys,
		deletedSnapshotKvKeys,
		kvDeleteErrors,
		hasMore: rows.length >= batchSize,
	}
})

const rowidPolicy = (
	name: string,
	table: string,
	orderColumn: string,
	cutoff: (now: Date) => string,
) =>
	Effect.fn(name)(function* (db: D1Service, options: BatchOptions) {
		return yield* selectAndDeleteByIds(db, {
			column: 'rowid',
			bindings: [
				cutoff(today(options.now)),
				options.batchSize ?? retentionDefaultBatchSize,
			],
			sql: `SELECT rowid
			FROM ${table}
			WHERE ${orderColumn} < ?
			ORDER BY ${orderColumn} ASC, rowid ASC
			LIMIT ?`,
			table,
			idColumn: 'rowid',
		})
	})

export const pruneUsageRollupsForRetentionEffect = rowidPolicy(
	'Retention.pruneUsageRollups',
	'usage_rollups',
	'month',
	(now) => cutoffMonth(now, usageRollupRetentionMonths),
)

export const pruneFeatureFlagExposuresForRetentionEffect = rowidPolicy(
	'Retention.pruneFeatureFlagExposures',
	'feature_flag_exposure_rollups',
	'day',
	(now) =>
		cutoffIso(now, featureFlagExposureRetentionDays).slice(
			0,
			'YYYY-MM-DD'.length,
		),
)

export const pruneAgentPackageConversationUsesForRetentionEffect = rowidPolicy(
	'Retention.pruneAgentPackageConversationUses',
	'agent_package_conversation_uses',
	'last_used_at',
	(now) => cutoffIso(now, agentPackageConversationUseRetentionDays),
)

export const pruneAuditEventsForRetentionEffect = Effect.fn(
	'Retention.pruneAuditEvents',
)(function* (db: D1Service, options: BatchOptions) {
	return yield* selectAndDeleteByIds(db, {
		bindings: [
			cutoffIso(today(options.now), auditEventRetentionDays),
			options.batchSize ?? retentionDefaultBatchSize,
		],
		sql: `SELECT id
			FROM audit_events
			WHERE timestamp < ?
			ORDER BY timestamp ASC, id ASC
			LIMIT ?`,
		table: 'audit_events',
		idColumn: 'id',
	})
})

export const pruneStripeWebhookEventsForRetentionEffect = Effect.fn(
	'Retention.pruneStripeWebhookEvents',
)(function* (db: D1Service, options: BatchOptions) {
	return yield* selectAndDeleteByIds(db, {
		column: 'event_id',
		bindings: [
			cutoffIso(today(options.now), stripeWebhookEventRetentionDays),
			options.batchSize ?? retentionDefaultBatchSize,
		],
		sql: `SELECT event_id
			FROM stripe_webhook_events
			WHERE processed_at < ?
			ORDER BY processed_at ASC, event_id ASC
			LIMIT ?`,
		table: 'stripe_webhook_events',
		idColumn: 'event_id',
	})
})

type RetentionTask = {
	readonly table: string
	/** One batch; succeeds with whether the table may have more to prune. */
	readonly run: Effect.Effect<boolean, DatabaseError | OutboundCallError>
}

function emptyRetentionResult(): RetentionPruneResult {
	return {
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
		credentialLocalReadEvents: 0,
		credentialRawSigningEvents: 0,
		auditEvents: 0,
		stripeWebhookEvents: 0,
		agentPackageConversationUses: 0,
		profiles: 0,
		batchesPerTable: {},
		timeBudgetExhausted: false,
	}
}

/**
 * Round-robin passes: every pending table gets one batch before any table
 * gets a second one, so a hot table cannot starve the others. The first pass
 * always completes so each table makes progress every run; later passes stop
 * once the time budget is exhausted.
 */
export const pruneRetentionEffect = Effect.fn('Retention.prune')(
	function* (input: { readonly now?: Date; readonly timeBudgetMs?: number }) {
		const env = yield* WorkerEnv
		const db = yield* D1
		const auditDb = makeD1(() => env.AUDIT_DB)
		const now = today(input.now)
		const budget = yield* startPassBudget(
			input.timeBudgetMs ?? retentionRunTimeBudgetMs,
		)
		const result = emptyRetentionResult()
		type Counted = Effect.Effect<
			{ selected: number; deleted: number },
			DatabaseError | OutboundCallError
		>
		const counted = (
			table: string,
			prune: Counted,
			assign: (deleted: number) => void,
		): RetentionTask => ({
			table,
			run: Effect.map(prune, (batch) => {
				assign(batch.deleted)
				// hasMore keys off the selected count so a full batch that deleted
				// fewer rows (racing writers) does not mark the table drained early.
				return batch.selected >= retentionDefaultBatchSize
			}),
		})
		const deletedOnly = (
			operation: string,
			prune: () => Promise<number>,
		): Counted =>
			Effect.map(outbound(operation, prune), (deleted) => ({
				selected: deleted,
				deleted,
			}))
		const tasks: ReadonlyArray<RetentionTask> = [
			counted(
				'mcp_memory_conversation_suppressions',
				pruneMemorySuppressionsForRetentionEffect(db, { now }),
				(count) => (result.memorySuppressions += count),
			),
			counted(
				'platform_feedback',
				prunePlatformFeedbackForRetentionEffect(db, { now }),
				(count) => (result.platformFeedback += count),
			),
			{
				table: 'published_bundle_artifacts',
				run: Effect.map(
					prunePublishedBundleArtifactsForRetentionEffect(env, db, { now }),
					(batch) => {
						const totals = result.publishedBundleArtifacts
						totals.deletedRows += batch.deletedRows
						totals.deletedKvKeys += batch.deletedKvKeys
						totals.deletedSnapshotKvKeys += batch.deletedSnapshotKvKeys
						totals.kvDeleteErrors += batch.kvDeleteErrors
						return batch.hasMore
					},
				),
			},
			counted(
				'usage_rollups',
				pruneUsageRollupsForRetentionEffect(db, { now }),
				(count) => (result.usageRollups += count),
			),
			counted(
				'feature_flag_exposure_rollups',
				pruneFeatureFlagExposuresForRetentionEffect(db, { now }),
				(count) => (result.featureFlagExposureRollups += count),
			),
			counted(
				'credential_local_read_events',
				deletedOnly('credentials.pruneLocalReadEvents', () =>
					pruneLocalReadEvents({
						db: env.APP_DB,
						now,
						batchSize: retentionDefaultBatchSize,
					}),
				),
				(count) => (result.credentialLocalReadEvents += count),
			),
			counted(
				'credential_raw_signing_events',
				deletedOnly('credentials.pruneRawSigningEvents', () =>
					pruneRawSigningEvents({
						db: env.APP_DB,
						now,
						batchSize: retentionDefaultBatchSize,
					}),
				),
				(count) => (result.credentialRawSigningEvents += count),
			),
			counted(
				'audit_events',
				pruneAuditEventsForRetentionEffect(auditDb, { now }),
				(count) => (result.auditEvents += count),
			),
			counted(
				'stripe_webhook_events',
				pruneStripeWebhookEventsForRetentionEffect(db, { now }),
				(count) => (result.stripeWebhookEvents += count),
			),
			counted(
				'agent_package_conversation_uses',
				pruneAgentPackageConversationUsesForRetentionEffect(db, { now }),
				(count) => (result.agentPackageConversationUses += count),
			),
			{
				table: 'profiles',
				run: Effect.map(
					outbound('profiles.purge', () => purgeProfiles(env.APP_DB, { now })),
					(purged) => {
						result.profiles += purged.profiles
						return false
					},
				),
			},
		]
		const pending = new Set(tasks)
		let pass = 0
		while (pending.size > 0) {
			if (pass > 0 && (yield* budget.reached)) {
				result.timeBudgetExhausted = true
				break
			}
			for (const task of tasks) {
				if (!pending.has(task)) continue
				if (pass > 0 && (yield* budget.reached)) break
				const hasMore = yield* task.run.pipe(
					Effect.withSpan('Retention.batch', {
						attributes: { table: task.table },
					}),
				)
				result.batchesPerTable[task.table] =
					(result.batchesPerTable[task.table] ?? 0) + 1
				if (!hasMore) pending.delete(task)
			}
			pass += 1
		}
		yield* Effect.logInfo('retention-prune', JSON.stringify(result))
		return result
	},
)

export function pruneMemorySuppressionsForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		pruneMemorySuppressionsForRetentionEffect(db, input),
	)
}
export function prunePlatformFeedbackForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		prunePlatformFeedbackForRetentionEffect(db, input),
	)
}
export function prunePublishedBundleArtifactsForRetention(
	input: { env: ArtifactEnv } & BatchOptions,
) {
	return runD1Promise(input.env.APP_DB, (db) =>
		prunePublishedBundleArtifactsForRetentionEffect(input.env, db, input),
	)
}
export function pruneUsageRollupsForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		pruneUsageRollupsForRetentionEffect(db, input),
	)
}
export function pruneFeatureFlagExposuresForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		pruneFeatureFlagExposuresForRetentionEffect(db, input),
	)
}
export function pruneAuditEventsForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		pruneAuditEventsForRetentionEffect(db, input),
	)
}
export function pruneStripeWebhookEventsForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		pruneStripeWebhookEventsForRetentionEffect(db, input),
	)
}
export function pruneAgentPackageConversationUsesForRetention(
	input: { db: D1Database } & BatchOptions,
) {
	return runD1Promise(input.db, (db) =>
		pruneAgentPackageConversationUsesForRetentionEffect(db, input),
	)
}

export function pruneRetention(input: {
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV'>
	now?: Date
	timeBudgetMs?: number
}): Promise<RetentionPruneResult> {
	const { env, ...rest } = input
	return runSlicePromise(env as Env, pruneRetentionEffect(rest))
}
