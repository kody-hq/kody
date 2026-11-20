/**
 * soft-delete-read-filter: opt-out
 *
 * Published-bundle retention must treat soft-deleted entity_sources as still
 * present so restore-window artifacts are not pruned before hard purge.
 */
import { purgeProfiles } from '#worker/profiles/store.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { accountRetentionDispositions } from '#app/account-retention-dispositions.ts'
import { z } from 'zod'
import { type Clock, systemClock } from '#worker/scheduled/retention/clock.ts'
import { startPassBudget } from '#worker/scheduled/retention/budget.ts'
import {
	d1All,
	d1First,
	d1Run,
	type RetentionContext,
} from '#worker/scheduled/retention/d1.ts'
import { ownerIdColumn } from '#worker/scheduled/retention/rows.ts'
import { traced } from '#worker/scheduled/retention/telemetry.ts'
import { withTimeout } from '#worker/scheduled/retention/timeout.ts'
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

const idValue = z.union([z.string(), z.number()])

/** Per-call ceiling for KV deletes and repo-session lookups in a pass. */
export const retentionOutboundTimeoutMs = 10_000

type RetentionClockInput = { clock?: Clock; signal?: AbortSignal }

function retentionContext(
	db: D1Database,
	input: RetentionClockInput,
): RetentionContext {
	return { db, clock: input.clock ?? systemClock, signal: input.signal }
}

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

async function selectIds(
	ctx: RetentionContext,
	input: {
		operation: string
		sql: string
		bindings: ReadonlyArray<string | number>
		column?: string
	},
): Promise<Array<IdValue>> {
	const column = input.column ?? 'id'
	return d1All(ctx, {
		operation: input.operation,
		sql: input.sql,
		bindings: input.bindings,
		row: z.record(z.string(), z.unknown()).transform((row, issues) => {
			const parsed = idValue.safeParse(row[column])
			if (parsed.success) return parsed.data
			issues.addIssue({
				code: 'custom',
				message: `${column} must be a string or number`,
			})
			return z.NEVER
		}),
	})
}

/**
 * Runs a batched select-then-delete and reports both counts. `selected` (not
 * `deleted`) is what callers should feed into hasMore decisions: a full batch
 * that deletes fewer rows (racing writers) must not mark a table drained.
 */
function selectAndDeleteByIds(
	ctx: RetentionContext,
	input: {
		sql: string
		bindings: ReadonlyArray<string | number>
		column?: string
		table: string
		idColumn: string
	},
): Promise<{ selected: number; deleted: number }> {
	return traced(
		`retention.prune.${input.table}`,
		{ 'retention.table': input.table },
		async (span) => {
			const ids = await selectIds(ctx, {
				...input,
				operation: `retention.select.${input.table}`,
			})
			const deleted = await deleteByIds(ctx, {
				table: input.table,
				idColumn: input.idColumn,
				ids,
			})
			span.setAttribute('retention.selected', ids.length)
			span.setAttribute('retention.deleted', deleted)
			return { selected: ids.length, deleted }
		},
		ctx.clock,
	)
}

async function deleteByIds(
	ctx: RetentionContext,
	input: {
		table: string
		idColumn: string
		ids: ReadonlyArray<IdValue>
	},
) {
	if (input.ids.length === 0) return 0
	let deleted = 0
	for (
		let index = 0;
		index < input.ids.length;
		index += retentionDeleteIdsMaxParameters
	) {
		const ids = input.ids.slice(index, index + retentionDeleteIdsMaxParameters)
		deleted += await d1Run(ctx, {
			operation: `retention.delete.${input.table}`,
			sql: `DELETE FROM ${input.table}
				WHERE ${input.idColumn} IN (${placeholders(ids)})`,
			bindings: ids,
		})
	}
	return deleted
}

/** KV delete with a timeout; KV bindings take no AbortSignal, so it races. */
function deleteKvKey(ctx: RetentionContext, kv: KVNamespace, key: string) {
	return traced(
		'retention.kv.delete',
		{},
		() =>
			withTimeout({
				operation: 'retention.kv.delete',
				timeoutMs: retentionOutboundTimeoutMs,
				clock: ctx.clock,
				signal: ctx.signal,
				run: () => kv.delete(key),
			}),
		ctx.clock,
	)
}

async function deletePublishedBundleArtifactRowIfStillStale(
	ctx: RetentionContext,
	input: {
		env: Pick<Env, 'APP_DB'> & RepoSessionIndexEnv
		id: string
		kvKey: string
		cutoff: string
		userId: OwnerId
		sourceId: string
	},
) {
	const hasActiveSession = await traced(
		'retention.published_bundle_artifacts.active_repo_session',
		{},
		() =>
			withTimeout({
				operation: 'retention.published_bundle_artifacts.active_repo_session',
				timeoutMs: retentionOutboundTimeoutMs,
				clock: ctx.clock,
				signal: ctx.signal,
				run: () =>
					hasActiveRepoSessionForSource(input.env, {
						userId: input.userId,
						sourceId: input.sourceId,
					}),
			}),
		ctx.clock,
	)
	if (hasActiveSession) return 0
	return d1Run(ctx, {
		operation: 'retention.delete.published_bundle_artifacts',
		sql: `DELETE FROM published_bundle_artifacts
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
		bindings: [input.id, input.kvKey, input.cutoff],
	})
}

export function pruneMemorySuppressionsForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	const now = input.now ?? ctx.clock.now()
	const cutoff = cutoffIso(now, memorySuppressionRetentionDays)
	return selectAndDeleteByIds(ctx, {
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

export function prunePlatformFeedbackForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	return traced(
		'retention.prune.platform_feedback',
		{ 'retention.table': 'platform_feedback' },
		async (span) => {
			const cutoff = cutoffIso(
				input.now ?? ctx.clock.now(),
				platformFeedbackRetentionDays,
			)
			const ids = await selectIds(ctx, {
				operation: 'retention.select.platform_feedback',
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
				deleted += await d1Run(ctx, {
					operation: 'retention.delete.platform_feedback',
					sql: `DELETE FROM platform_feedback
					WHERE id IN (${placeholders(chunk)})
						AND status IN ('resolved', 'dismissed')
						AND updated_at < ?`,
					bindings: [...chunk, cutoff],
				})
			}
			span.setAttribute('retention.selected', ids.length)
			span.setAttribute('retention.deleted', deleted)
			return { selected: ids.length, deleted }
		},
		ctx.clock,
	)
}

const publishedBundleArtifactRow = z.object({
	id: z.string(),
	kv_key: z.string(),
	source_id: z.string(),
	user_id: ownerIdColumn,
	published_commit: z.string(),
})

export function prunePublishedBundleArtifactsForRetention(
	input: {
		env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'> & RepoSessionIndexEnv
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.env.APP_DB, input)
	return traced(
		'retention.prune.published_bundle_artifacts',
		{ 'retention.table': 'published_bundle_artifacts' },
		async (span) => {
			const cutoff = cutoffIso(
				input.now ?? ctx.clock.now(),
				publishedBundleArtifactRetentionDays,
			)
			const batchSize =
				input.batchSize ?? publishedBundleArtifactRetentionBatchSize
			const rows = await d1All(ctx, {
				operation: 'retention.select.published_bundle_artifacts',
				sql: `SELECT artifact.id, artifact.kv_key, artifact.source_id, artifact.user_id, artifact.published_commit
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
				bindings: [cutoff, batchSize],
				row: publishedBundleArtifactRow,
			})
			let deletedRows = 0
			let deletedKvKeys = 0
			let deletedSnapshotKvKeys = 0
			let kvDeleteErrors = 0
			const prunedSnapshotPairs = new Map<
				string,
				{ sourceId: string; publishedCommit: string }
			>()
			for (const row of rows) {
				const rowDeleted = await deletePublishedBundleArtifactRowIfStillStale(
					ctx,
					{
						env: input.env,
						id: row.id,
						kvKey: row.kv_key,
						cutoff,
						userId: row.user_id,
						sourceId: row.source_id,
					},
				)
				if (rowDeleted === 0) continue
				deletedRows += rowDeleted
				prunedSnapshotPairs.set(`${row.source_id}:${row.published_commit}`, {
					sourceId: row.source_id,
					publishedCommit: row.published_commit,
				})
				try {
					await deleteKvKey(ctx, input.env.BUNDLE_ARTIFACTS_KV, row.kv_key)
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
			// A pruned row already satisfied the safety conditions (commit neither
			// published nor serving for any entity_sources row, not pinned by an active community listing, no
			// active repo session), so the source snapshot KV keys for that commit are
			// stale too.
			for (const pair of prunedSnapshotPairs.values()) {
				try {
					// A newer artifact of this commit may remain and still reads its
					// linked modules, so they go only with the commit's last artifact.
					const remaining = await d1First(ctx, {
						operation: 'retention.select.published_bundle_artifacts_remaining',
						sql: `SELECT 1 AS present FROM published_bundle_artifacts
					WHERE source_id = ? AND published_commit = ? LIMIT 1`,
						bindings: [pair.sourceId, pair.publishedCommit],
						row: z.object({ present: z.number() }),
					})
					if (!remaining) {
						deletedSnapshotKvKeys += await traced(
							'retention.kv.delete_linked_artifact_groups',
							{},
							() =>
								withTimeout({
									operation: 'retention.kv.delete_linked_artifact_groups',
									timeoutMs: retentionOutboundTimeoutMs,
									clock: ctx.clock,
									signal: ctx.signal,
									run: () =>
										deleteLinkedArtifactGroups({
											kv: input.env.BUNDLE_ARTIFACTS_KV,
											prefix: linkedArtifactCommitKvPrefix(pair),
										}),
								}),
							ctx.clock,
						)
					}
				} catch (error) {
					kvDeleteErrors += 1
					console.warn('retention-linked-artifact-kv-delete-failed', {
						sourceId: pair.sourceId,
						publishedCommit: pair.publishedCommit,
						error,
					})
				}
				for (const kvKey of [
					buildPublishedSourceSnapshotKvKey(pair),
					buildPublishedSourceManifestSnapshotKvKey(pair),
					buildPublishedCredentialNeedsKvKey(pair),
					buildPublishedCredentialStampKvKey(pair),
				]) {
					try {
						await deleteKvKey(ctx, input.env.BUNDLE_ARTIFACTS_KV, kvKey)
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
			span.setAttribute('retention.selected', rows.length)
			span.setAttribute('retention.deleted', deletedRows)
			span.setAttribute('retention.kv_delete_errors', kvDeleteErrors)
			return {
				deletedRows,
				deletedKvKeys,
				deletedSnapshotKvKeys,
				kvDeleteErrors,
				hasMore: rows.length >= batchSize,
			}
		},
		ctx.clock,
	)
}

export function pruneUsageRollupsForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	const oldestKeptMonth = cutoffMonth(
		input.now ?? ctx.clock.now(),
		usageRollupRetentionMonths,
	)
	return selectAndDeleteByIds(ctx, {
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

export function pruneFeatureFlagExposuresForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	const cutoffDay = cutoffIso(
		input.now ?? ctx.clock.now(),
		featureFlagExposureRetentionDays,
	).slice(0, 'YYYY-MM-DD'.length)
	return selectAndDeleteByIds(ctx, {
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

export function pruneAuditEventsForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	const cutoff = cutoffIso(
		input.now ?? ctx.clock.now(),
		auditEventRetentionDays,
	)
	return selectAndDeleteByIds(ctx, {
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

export function pruneStripeWebhookEventsForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	const cutoff = cutoffIso(
		input.now ?? ctx.clock.now(),
		stripeWebhookEventRetentionDays,
	)
	return selectAndDeleteByIds(ctx, {
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

export function pruneAgentPackageConversationUsesForRetention(
	input: {
		db: D1Database
		now?: Date
		batchSize?: number
	} & RetentionClockInput,
) {
	const ctx = retentionContext(input.db, input)
	const cutoff = cutoffIso(
		input.now ?? ctx.clock.now(),
		agentPackageConversationUseRetentionDays,
	)
	return selectAndDeleteByIds(ctx, {
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

export function pruneRetention(
	input: {
		env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV'>
		now?: Date
		timeBudgetMs?: number
	} & RetentionClockInput,
): Promise<RetentionPruneResult> {
	const clock = input.clock ?? systemClock
	return traced(
		'retention.prune',
		{},
		async (span) => {
			const result = await runRetentionPasses({ ...input, clock })
			span.setAttribute(
				'retention.budget_exhausted',
				result.timeBudgetExhausted,
			)
			span.setAttribute(
				'retention.batches',
				Object.values(result.batchesPerTable).reduce((a, b) => a + b, 0),
			)
			return result
		},
		clock,
	)
}

async function runRetentionPasses(input: {
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'BUNDLE_ARTIFACTS_KV'>
	now?: Date
	timeBudgetMs?: number
	clock: Clock
	signal?: AbortSignal
}): Promise<RetentionPruneResult> {
	const { clock, signal } = input
	const now = input.now ?? clock.now()
	const budget = startPassBudget(
		clock,
		input.timeBudgetMs ?? retentionRunTimeBudgetMs,
	)
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
		credentialLocalReadEvents: 0,
		credentialRawSigningEvents: 0,
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
			() => pruneMemorySuppressionsForRetention({ db, now, clock, signal }),
			(count) => {
				result.memorySuppressions += count
			},
		),
		countTask(
			'platform_feedback',
			() => prunePlatformFeedbackForRetention({ db, now, clock, signal }),
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
					clock,
					signal,
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
			() => pruneUsageRollupsForRetention({ db, now, clock, signal }),
			(count) => {
				result.usageRollups += count
			},
		),
		countTask(
			'feature_flag_exposure_rollups',
			() => pruneFeatureFlagExposuresForRetention({ db, now, clock, signal }),
			(count) => {
				result.featureFlagExposureRollups += count
			},
		),
		countTask(
			'credential_local_read_events',
			async () => {
				const deleted = await traced(
					'retention.prune.credential_local_read_events',
					{ 'retention.table': 'credential_local_read_events' },
					() =>
						pruneLocalReadEvents({
							db,
							now,
							batchSize: retentionDefaultBatchSize,
						}),
					clock,
				)
				return { selected: deleted, deleted }
			},
			(count) => {
				result.credentialLocalReadEvents += count
			},
		),
		countTask(
			'credential_raw_signing_events',
			async () => {
				const deleted = await traced(
					'retention.prune.credential_raw_signing_events',
					{ 'retention.table': 'credential_raw_signing_events' },
					() =>
						pruneRawSigningEvents({
							db,
							now,
							batchSize: retentionDefaultBatchSize,
						}),
					clock,
				)
				return { selected: deleted, deleted }
			},
			(count) => {
				result.credentialRawSigningEvents += count
			},
		),
		countTask(
			'audit_events',
			() => pruneAuditEventsForRetention({ db: auditDb, now, clock, signal }),
			(count) => {
				result.auditEvents += count
			},
		),
		countTask(
			'stripe_webhook_events',
			() => pruneStripeWebhookEventsForRetention({ db, now, clock, signal }),
			(count) => {
				result.stripeWebhookEvents += count
			},
		),
		countTask(
			'agent_package_conversation_uses',
			() =>
				pruneAgentPackageConversationUsesForRetention({
					db,
					now,
					clock,
					signal,
				}),
			(count) => {
				result.agentPackageConversationUses += count
			},
		),
		{
			table: 'profiles',
			done: false,
			run: async () => {
				const purged = await traced(
					'retention.prune.profiles',
					{ 'retention.table': 'profiles' },
					() => purgeProfiles(db, { now }),
					clock,
				)
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
		if (pass > 0 && budget.reached()) {
			result.timeBudgetExhausted = true
			break
		}
		for (const task of tasks) {
			if (task.done) continue
			if (pass > 0 && budget.reached()) break
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
