import { parseJsonWithFallback } from '../json-parsing.ts'
import { type OwnerId } from '../owner-person-ids.ts'
import { requirePackageIdFromJobId } from './package-job-id.ts'
import { jobExpiredDisabledReason } from './disabled-reason.ts'
import { createJobStorageId } from './storage-id.ts'
import { type JobRecord, type PersistedJobCallerContext } from './types.ts'

type JobRowRecord = {
	id: string
	/** Owner id bytes as stored. JobManager names use this value untrimmed. */
	user_id: OwnerId
	/** Provenance only (Teams P3+). Falls back to user_id when absent. */
	created_by_user_id: string | null
	deleted_at: string | null
	deleting_at: string | null
	name: string
	source_id: string
	published_commit: string | null
	repo_check_policy_json: string | null
	storage_id: string | null
	params_json: string | null
	schedule_json: string
	timezone: string
	enabled: number
	kill_switch_enabled: number
	expires_at: string | null
	disabled_reason: string | null
	caller_context_json: string
	created_at: string
	updated_at: string
	last_run_at: string | null
	last_run_status: JobRecord['lastRunStatus'] | null
	next_run_at: string
	claim_token: string | null
	running_since: string | null
	lease_expires_at: string | null
	claimed_scheduled_for: string | null
	retry_scheduled_for: string | null
	retry_count: number
	last_completed_scheduled_for: string | null
}

export type JobRow = JobRowRecord & {
	record: JobRecord
	callerContextJson: string
	callerContext: PersistedJobCallerContext | null
	schedulerWakeAt: string
}

function serializeJob(job: JobRecord) {
	return {
		id: job.id,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit ?? null,
		repo_check_policy_json: job.repoCheckPolicy
			? JSON.stringify(job.repoCheckPolicy)
			: null,
		storage_id: job.storageId,
		params_json: job.params ? JSON.stringify(job.params) : null,
		schedule_json: JSON.stringify(job.schedule),
		timezone: job.timezone,
		enabled: job.enabled ? 1 : 0,
		kill_switch_enabled: job.killSwitchEnabled ? 1 : 0,
		expires_at: job.expiresAt ?? null,
		// A job that is on has no disabled reason.
		disabled_reason: job.enabled ? null : (job.disabledReason ?? null),
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		last_run_at: job.lastRunAt ?? null,
		last_run_status: job.lastRunStatus ?? null,
		next_run_at: job.nextRunAt,
	}
}

function mapRow(row: Record<string, unknown>): JobRow {
	const jobId = String(row['id'])
	const rawStorageId = row['storage_id']
	const storageId =
		rawStorageId == null ? createJobStorageId(jobId) : String(rawStorageId)
	const record: JobRecord = {
		version: 1,
		id: jobId,
		userId: String(row['user_id']) as OwnerId,
		name: String(row['name']),
		sourceId: String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		repoCheckPolicy: parseJsonWithFallback<
			JobRecord['repoCheckPolicy'] | undefined
		>(
			row['repo_check_policy_json'] == null
				? null
				: String(row['repo_check_policy_json']),
			undefined,
		),
		storageId,
		params: parseJsonWithFallback<Record<string, unknown> | undefined>(
			row['params_json'] == null ? null : String(row['params_json']),
			undefined,
		),
		schedule: (() => {
			const schedule = parseJsonWithFallback<JobRecord['schedule'] | null>(
				String(row['schedule_json']),
				null,
			)
			if (!schedule) {
				throw new Error(
					`Job "${jobId}" has an invalid schedule_json; expected a cron or interval schedule.`,
				)
			}
			return schedule
		})(),
		timezone: String(row['timezone']),
		enabled: Number(row['enabled']) === 1,
		killSwitchEnabled: Number(row['kill_switch_enabled']) === 1,
		expiresAt: row['expires_at'] == null ? null : String(row['expires_at']),
		disabledReason:
			Number(row['enabled']) === 1 || row['disabled_reason'] == null
				? null
				: String(row['disabled_reason']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		lastRunAt:
			row['last_run_at'] == null ? undefined : String(row['last_run_at']),
		lastRunStatus:
			row['last_run_status'] == null
				? undefined
				: (String(row['last_run_status']) as JobRecord['lastRunStatus']),
		lastRunError: undefined,
		lastDurationMs: undefined,
		nextRunAt: String(row['next_run_at']),
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	return {
		id: record.id,
		user_id: String(row['user_id']) as OwnerId,
		created_by_user_id:
			row['created_by_user_id'] == null
				? null
				: String(row['created_by_user_id']),
		deleted_at: row['deleted_at'] == null ? null : String(row['deleted_at']),
		deleting_at: row['deleting_at'] == null ? null : String(row['deleting_at']),
		name: record.name,
		source_id: record.sourceId,
		published_commit: record.publishedCommit ?? null,
		repo_check_policy_json:
			row['repo_check_policy_json'] == null
				? null
				: String(row['repo_check_policy_json']),
		storage_id: record.storageId,
		params_json: row['params_json'] == null ? null : String(row['params_json']),
		schedule_json: String(row['schedule_json']),
		timezone: record.timezone,
		enabled: record.enabled ? 1 : 0,
		kill_switch_enabled: record.killSwitchEnabled ? 1 : 0,
		expires_at: record.expiresAt,
		disabled_reason: record.disabledReason ?? null,
		caller_context_json: String(row['caller_context_json']),
		created_at: record.createdAt,
		updated_at: record.updatedAt,
		last_run_at: record.lastRunAt ?? null,
		last_run_status: record.lastRunStatus ?? null,
		next_run_at: record.nextRunAt,
		claim_token: row['claim_token'] == null ? null : String(row['claim_token']),
		running_since:
			row['running_since'] == null ? null : String(row['running_since']),
		lease_expires_at:
			row['lease_expires_at'] == null ? null : String(row['lease_expires_at']),
		claimed_scheduled_for:
			row['claimed_scheduled_for'] == null
				? null
				: String(row['claimed_scheduled_for']),
		retry_scheduled_for:
			row['retry_scheduled_for'] == null
				? null
				: String(row['retry_scheduled_for']),
		retry_count: Number(row['retry_count']) || 0,
		last_completed_scheduled_for:
			row['last_completed_scheduled_for'] == null
				? null
				: String(row['last_completed_scheduled_for']),
		record,
		callerContextJson: String(row['caller_context_json']),
		callerContext: parseJsonWithFallback<PersistedJobCallerContext | null>(
			row['caller_context_json'] == null
				? null
				: String(row['caller_context_json']),
			null,
		),
		schedulerWakeAt:
			row['scheduler_wake_at'] == null
				? record.nextRunAt
				: String(row['scheduler_wake_at']),
	}
}

export async function insertJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	requirePackageIdFromJobId(input.job.id)
	const serialized = serializeJob(input.job)
	await input.db
		.prepare(
			`INSERT INTO jobs (
				id, user_id, name, source_id, published_commit, repo_check_policy_json, storage_id, params_json, schedule_json, timezone, enabled,
				kill_switch_enabled, expires_at, caller_context_json, created_at, updated_at,
				last_run_at, last_run_status, next_run_at, disabled_reason
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			serialized.id,
			input.userId,
			serialized.name,
			serialized.source_id,
			serialized.published_commit,
			serialized.repo_check_policy_json,
			serialized.storage_id,
			serialized.params_json,
			serialized.schedule_json,
			serialized.timezone,
			serialized.enabled,
			serialized.kill_switch_enabled,
			serialized.expires_at,
			input.callerContextJson,
			serialized.created_at,
			serialized.updated_at,
			serialized.last_run_at,
			serialized.last_run_status,
			serialized.next_run_at,
			serialized.disabled_reason,
		)
		.run()
}

export async function updateJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const serialized = serializeJob(input.job)
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				name = ?, source_id = ?, published_commit = ?, repo_check_policy_json = ?, storage_id = ?, params_json = ?, schedule_json = ?, timezone = ?,
				enabled = ?, kill_switch_enabled = ?, expires_at = ?, caller_context_json = ?, updated_at = ?,
				last_run_at = ?, last_run_status = ?,
				next_run_at = ?,
				claim_token = NULL, running_since = NULL, lease_expires_at = NULL,
				claimed_scheduled_for = NULL, retry_scheduled_for = NULL,
				retry_count = 0, disabled_reason = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			serialized.name,
			serialized.source_id,
			serialized.published_commit,
			serialized.repo_check_policy_json,
			serialized.storage_id,
			serialized.params_json,
			serialized.schedule_json,
			serialized.timezone,
			serialized.enabled,
			serialized.kill_switch_enabled,
			serialized.expires_at,
			input.callerContextJson,
			serialized.updated_at,
			serialized.last_run_at,
			serialized.last_run_status,
			serialized.next_run_at,
			serialized.disabled_reason,
			serialized.id,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getJobRowById(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<JobRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM jobs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(jobId, userId)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

export async function listJobRowsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM jobs WHERE user_id = ? AND deleted_at IS NULL ORDER BY next_run_at ASC, name ASC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

/**
 * Caps how many due jobs a single JobManager alarm invocation picks up so a
 * large backlog cannot exhaust the Durable Object CPU budget in one wake. The
 * post-run alarm resync schedules a near-immediate follow-up wake whenever
 * more due jobs remain, so backlogs drain across successive alarms.
 */
export const maxDueJobsPerAlarm = 25

// Keyset-paged listing across all users, used by maintenance reindex so a
// single query never loads the whole table. Pass the last row id of the
// previous page (or null for the first page).
export async function listJobRowsPage(
	db: D1Database,
	input: {
		afterId: string | null
		limit: number
	},
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(`SELECT * FROM jobs WHERE id > ? ORDER BY id LIMIT ?`)
		.bind(input.afterId ?? '', input.limit)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

export async function listDueJobRows(
	db: D1Database,
	userId: string,
	nowIso: string,
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM jobs
			WHERE user_id = ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND (expires_at IS NULL OR expires_at > ?)
				AND next_run_at <= ?
				AND (
					claim_token IS NULL
					OR lease_expires_at IS NULL
					OR lease_expires_at <= ?
				)
				AND (
					last_completed_scheduled_for IS NULL
					OR last_completed_scheduled_for != COALESCE(retry_scheduled_for, next_run_at)
				)
			ORDER BY next_run_at ASC, name ASC
			LIMIT ?`,
		)
		.bind(userId, nowIso, nowIso, nowIso, maxDueJobsPerAlarm)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

/**
 * Cross-user keyset page of enabled jobs whose next occurrence is past the
 * watchdog grace cutoff and not currently leased. Used by the schedule
 * watchdog to re-arm JobManager alarms when a user's Durable Object alarm was
 * lost or drifted while due work remained claimable.
 */
export async function listSilentlyOverdueJobRowsPage(
	db: D1Database,
	input: {
		overdueBeforeIso: string
		nowIso: string
		afterId: string | null
		limit: number
	},
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM jobs
			WHERE id > ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND (expires_at IS NULL OR expires_at > ?)
				AND next_run_at <= ?
				AND (
					claim_token IS NULL
					OR lease_expires_at IS NULL
					OR lease_expires_at <= ?
				)
				AND (
					last_completed_scheduled_for IS NULL
					OR last_completed_scheduled_for != COALESCE(retry_scheduled_for, next_run_at)
				)
			ORDER BY id ASC
			LIMIT ?`,
		)
		.bind(
			input.afterId ?? '',
			input.nowIso,
			input.overdueBeforeIso,
			input.nowIso,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

/**
 * Enabled jobs permanently skipped by the occurrence fence:
 * `last_completed_scheduled_for` still equals the current occurrence key, so
 * due selection and claims never pick them up again until next_run_at moves.
 */
export async function listStuckSkippedJobRowsPage(
	db: D1Database,
	input: {
		nowIso: string
		afterId: string | null
		limit: number
	},
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM jobs
			WHERE id > ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND (expires_at IS NULL OR expires_at > ?)
				AND last_completed_scheduled_for IS NOT NULL
				AND last_completed_scheduled_for = COALESCE(retry_scheduled_for, next_run_at)
			ORDER BY id ASC
			LIMIT ?`,
		)
		.bind(input.afterId ?? '', input.nowIso, input.limit)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

export async function advanceStuckSkippedJobNextRunAt(input: {
	db: D1Database
	userId: string
	jobId: string
	nextRunAt: string
	updatedAt: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				next_run_at = ?,
				updated_at = ?,
				retry_scheduled_for = NULL,
				retry_count = 0
			WHERE id = ?
				AND user_id = ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND last_completed_scheduled_for IS NOT NULL
				AND last_completed_scheduled_for = COALESCE(retry_scheduled_for, next_run_at)
				AND next_run_at != ?`,
		)
		.bind(
			input.nextRunAt,
			input.updatedAt,
			input.jobId,
			input.userId,
			input.nextRunAt,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getNextRunnableJobRow(
	db: D1Database,
	userId: string,
	nowIso = new Date().toISOString(),
): Promise<JobRow | null> {
	const result = await db
		.prepare(
			`SELECT jobs.*,
				CASE
					WHEN claim_token IS NOT NULL
						AND lease_expires_at IS NOT NULL
						AND lease_expires_at > ?
					THEN lease_expires_at
					WHEN expires_at IS NOT NULL
						AND expires_at < next_run_at
					THEN expires_at
					ELSE next_run_at
				END AS scheduler_wake_at
			FROM jobs
			WHERE user_id = ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND (expires_at IS NULL OR expires_at > ?)
				AND (
					last_completed_scheduled_for IS NULL
					OR last_completed_scheduled_for != COALESCE(retry_scheduled_for, next_run_at)
				)
			ORDER BY scheduler_wake_at ASC, name ASC
			LIMIT 1`,
		)
		.bind(nowIso, userId, nowIso)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

/**
 * Scheduled executions use a ten-minute lease, twice the 5-minute job
 * sandbox budget (`backgroundExecutorTimeoutMs`), renewed before each further
 * enablement run of the same tick ({@link renewClaimedJobRow}). A single
 * conditional D1 write is the ownership boundary; reading due rows alone never
 * grants ownership.
 */
export const jobExecutionLeaseMs = 10 * 60 * 1_000

export async function claimJobRow(input: {
	db: D1Database
	userId: string
	jobId: string
	now: Date
	claimToken: string
}): Promise<JobRow | null> {
	const nowIso = input.now.toISOString()
	const leaseExpiresAt = new Date(
		input.now.valueOf() + jobExecutionLeaseMs,
	).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				claim_token = ?,
				running_since = ?,
				lease_expires_at = ?,
				claimed_scheduled_for = COALESCE(retry_scheduled_for, next_run_at)
			WHERE id = ?
				AND user_id = ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND (expires_at IS NULL OR expires_at > ?)
				AND next_run_at <= ?
				AND (
					claim_token IS NULL
					OR lease_expires_at IS NULL
					OR lease_expires_at <= ?
				)
				AND (
					last_completed_scheduled_for IS NULL
					OR last_completed_scheduled_for != COALESCE(retry_scheduled_for, next_run_at)
				)
			RETURNING *`,
		)
		.bind(
			input.claimToken,
			nowIso,
			leaseExpiresAt,
			input.jobId,
			input.userId,
			nowIso,
			nowIso,
			nowIso,
		)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

/**
 * Pushes a held claim's lease to `now + jobExecutionLeaseMs` before the next
 * run of a multi-enablement tick, so each run starts with the full lease.
 * Returns false when the claim was lost (token no longer matches).
 */
export async function renewClaimedJobRow(input: {
	db: D1Database
	userId: string
	jobId: string
	claimToken: string
	nowMs: number
}): Promise<boolean> {
	const leaseExpiresAt = new Date(
		input.nowMs + jobExecutionLeaseMs,
	).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE jobs SET lease_expires_at = ?
			WHERE id = ? AND user_id = ? AND claim_token = ?`,
		)
		.bind(leaseExpiresAt, input.jobId, input.userId, input.claimToken)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function finalizeClaimedJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	claimToken: string
	scheduledFor: string
}): Promise<boolean> {
	const serialized = serializeJob(input.job)
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				enabled = ?, updated_at = ?, last_run_at = ?, last_run_status = ?,
				next_run_at = ?,
				claim_token = NULL, running_since = NULL, lease_expires_at = NULL,
				claimed_scheduled_for = NULL, retry_scheduled_for = NULL,
				retry_count = 0, last_completed_scheduled_for = ?, disabled_reason = ?
			WHERE id = ? AND user_id = ? AND claim_token = ?`,
		)
		.bind(
			serialized.enabled,
			serialized.updated_at,
			serialized.last_run_at,
			serialized.last_run_status,
			serialized.next_run_at,
			input.scheduledFor,
			serialized.disabled_reason,
			serialized.id,
			input.userId,
			input.claimToken,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function retryClaimedJobRow(input: {
	db: D1Database
	userId: string
	jobId: string
	claimToken: string
	nextRunAt: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				next_run_at = ?,
				updated_at = ?,
				retry_scheduled_for = claimed_scheduled_for,
				retry_count = retry_count + 1,
				claim_token = NULL,
				running_since = NULL,
				lease_expires_at = NULL,
				claimed_scheduled_for = NULL
			WHERE id = ? AND user_id = ? AND claim_token = ?`,
		)
		.bind(
			input.nextRunAt,
			new Date().toISOString(),
			input.jobId,
			input.userId,
			input.claimToken,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Refresh package-owned execution identity without disturbing an in-flight
 * scheduler claim or recomputing the next occurrence.
 */
/**
 * Records a Run now outcome without rewriting the job's settings. Run now can
 * execute for minutes, so it must not save the row it read before running:
 * that would undo a turn-off, an edit, or a publish that landed meanwhile.
 * `next_run_at` moves only when the schedule is still the one it ran under.
 */
export async function recordJobRunNowOutcomeRow(input: {
	db: D1Database
	userId: string
	jobId: string
	lastRunAt: string
	lastRunStatus: JobRecord['lastRunStatus']
	updatedAt: string
	nextRunAt: string
	scheduleJson: string
	timezone: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				last_run_at = ?, last_run_status = ?, updated_at = ?,
				next_run_at = CASE
					WHEN schedule_json = ? AND timezone = ? THEN ?
					ELSE next_run_at
				END
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			input.lastRunAt,
			input.lastRunStatus ?? null,
			input.updatedAt,
			input.scheduleJson,
			input.timezone,
			input.nextRunAt,
			input.jobId,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function refreshPackageJobRowIdentity(input: {
	db: D1Database
	userId: string
	jobId: string
	sourceId: string
	publishedCommit: string | null
	callerContextJson: string
	updatedAt: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				source_id = ?, published_commit = ?, caller_context_json = ?, updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			input.sourceId,
			input.publishedCommit,
			input.callerContextJson,
			input.updatedAt,
			input.jobId,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Replace only `caller_context_json` (and `updated_at`) when the row still
 * holds `expectedCallerContextJson`. Does not touch schedule, claims, or
 * retry fields — for repair backfills that must not race a live tick.
 */
export async function updateJobRowCallerContextJson(input: {
	db: D1Database
	userId: string
	jobId: string
	expectedCallerContextJson: string
	callerContextJson: string
	updatedAt: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE jobs SET caller_context_json = ?, updated_at = ?
			WHERE id = ? AND user_id = ? AND caller_context_json = ?
				AND deleted_at IS NULL`,
		)
		.bind(
			input.callerContextJson,
			input.updatedAt,
			input.jobId,
			input.userId,
			input.expectedCallerContextJson,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function softDeleteJobRowsForUser(input: {
	db: D1Database
	userId: string
	deletedAt: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`UPDATE jobs
			 SET deleted_at = ?,
			     enabled_before_soft_delete = enabled,
			     enabled = 0,
			     updated_at = ?
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.deletedAt, input.deletedAt, input.userId)
		.run()
	return result.meta.changes ?? 0
}

export async function restoreJobRowsForUser(input: {
	db: D1Database
	userId: string
	deletedAt: string
	restoredAt: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`UPDATE jobs
			 SET deleted_at = NULL,
			     deleting_at = NULL,
			     enabled = COALESCE(enabled_before_soft_delete, enabled),
			     enabled_before_soft_delete = NULL,
			     updated_at = ?
			 WHERE user_id = ? AND deleted_at = ?`,
		)
		.bind(input.restoredAt, input.userId, input.deletedAt)
		.run()
	return result.meta.changes ?? 0
}

export async function deleteJobRow(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM jobs WHERE id = ? AND user_id = ?`)
		.bind(jobId, userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function transferJobRowsOwner(input: {
	db: D1Database
	fromUserId: string
	toUserId: string
	jobs: Array<{ jobId: string; callerContextJson: string }>
	updatedAt: string
}): Promise<{ transferred: number }> {
	if (input.jobs.length === 0) return { transferred: 0 }
	const jobIds = input.jobs.map((job) => job.jobId)
	const { results } = await input.db
		.prepare(
			`SELECT id, caller_context_json, updated_at, claim_token
			 FROM jobs
			 WHERE user_id = ? AND deleted_at IS NULL
			   AND id IN (SELECT value FROM json_each(?))`,
		)
		.bind(input.fromUserId, JSON.stringify(jobIds))
		.all<{
			id: string
			caller_context_json: string
			updated_at: string
			claim_token: string | null
		}>()
	const current = new Map((results ?? []).map((row) => [row.id, row]))
	for (const jobId of jobIds) {
		const row = current.get(jobId)
		if (!row) throw new Error(`Job ${jobId} is not a live job of the source.`)
		if (row.claim_token) throw new Error(`Job ${jobId} is running; retry.`)
	}
	const statement = (
		jobId: string,
		owner: { from: string; to: string },
		callerContextJson: string,
		updatedAt: string,
	) =>
		input.db
			.prepare(
				`UPDATE jobs
				 SET user_id = ?, caller_context_json = ?, updated_at = ?
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND claim_token IS NULL`,
			)
			.bind(owner.to, callerContextJson, updatedAt, jobId, owner.from)
	const batchResults = await input.db.batch(
		input.jobs.map((job) =>
			statement(
				job.jobId,
				{ from: input.fromUserId, to: input.toUserId },
				job.callerContextJson,
				input.updatedAt,
			),
		),
	)
	const moved = input.jobs.filter(
		(_, index) => (batchResults[index]?.meta.changes ?? 0) > 0,
	)
	if (moved.length === input.jobs.length) {
		return { transferred: moved.length }
	}
	// A job was claimed between the check and the batch: put the rest back.
	await input.db.batch(
		moved.map((job) => {
			const original = current.get(job.jobId)!
			return statement(
				job.jobId,
				{ from: input.toUserId, to: input.fromUserId },
				original.caller_context_json,
				original.updated_at,
			)
		}),
	)
	throw new Error('A job changed during the transfer; nothing moved. Retry.')
}

/**
 * Auto-disable enabled jobs whose expires_at has passed. Expiry stops
 * scheduling. Returns the number of rows flipped to enabled = 0.
 */
export async function disableExpiredJobRowsForUser(input: {
	db: D1Database
	userId: string
	nowIso: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				enabled = 0,
				disabled_reason = ?,
				updated_at = ?
			WHERE user_id = ?
				AND enabled = 1
				AND expires_at IS NOT NULL
				AND expires_at <= ?`,
		)
		.bind(jobExpiredDisabledReason, input.nowIso, input.userId, input.nowIso)
		.run()
	return result.meta.changes ?? 0
}

export async function countJobRowsForUser(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE user_id = ?`)
		.bind(userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export type JobCountBySourceId = {
	sourceId: string
	count: number
}

/** Per-`source_id` job counts for one user. Does not load job rows. */
export async function countJobRowsBySourceId(
	db: D1Database,
	userId: string,
): Promise<Array<JobCountBySourceId>> {
	const { results } = await db
		.prepare(
			`SELECT source_id, COUNT(*) AS job_count
			FROM jobs
			WHERE user_id = ?
			GROUP BY source_id`,
		)
		.bind(userId)
		.all<{ source_id: string; job_count: number }>()
	return (results ?? []).map((row) => ({
		sourceId: String(row.source_id),
		count: Number(row.job_count ?? 0),
	}))
}

/**
 * Physical text-byte estimate of a user's job rows, mirroring the main
 * worker's `calculateUserD1StorageBytes` per-table formula so jobs data in the
 * jobs database counts toward the D1 storage quota.
 */
export async function sumJobRowsStorageBytesForUser(
	db: D1Database,
	userId: string,
): Promise<number> {
	const columns = [
		'name',
		'params_json',
		'schedule_json',
		'timezone',
		'caller_context_json',
		'last_run_status',
		'source_id',
		'published_commit',
		'storage_id',
	]
	const expression = columns
		.map((column) => `length(CAST(COALESCE(${column}, '') AS BLOB))`)
		.join(' + ')
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(${expression}), 0) AS count
			FROM jobs
			WHERE user_id = ?`,
		)
		.bind(userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function listJobIdRowsForUser(
	db: D1Database,
	userId: string,
): Promise<Array<string>> {
	const { results } = await db
		.prepare(`SELECT id FROM jobs WHERE user_id = ? ORDER BY id ASC`)
		.bind(userId)
		.all<{ id: string }>()
	return (results ?? []).map((row) => row.id)
}

export async function listJobStorageIdRowsForUser(
	db: D1Database,
	userId: string,
): Promise<Array<string>> {
	const { results } = await db
		.prepare(
			`SELECT storage_id AS storageId FROM jobs
			WHERE user_id = ? AND storage_id IS NOT NULL`,
		)
		.bind(userId)
		.all<{ storageId: string }>()
	return (results ?? []).map((row) => row.storageId)
}

/**
 * Platform-wide (userId, storageId) pairs for every job row with storage.
 * Operator-level DR inventory only — not for user-facing paths.
 */
export async function listAllJobStorageOwnerRows(
	db: D1Database,
): Promise<Array<{ userId: string; storageId: string }>> {
	const { results } = await db
		.prepare(
			`SELECT user_id AS userId, storage_id AS storageId
			FROM jobs WHERE storage_id IS NOT NULL`,
		)
		.all<{ userId: string; storageId: string }>()
	return results ?? []
}

export async function getJobRowInsights(
	db: D1Database,
): Promise<{ total: number; enabled: number }> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM jobs`)
		.first<{ total: number; enabled: number | null }>()
	return {
		total: Number(row?.total ?? 0),
		enabled: Number(row?.enabled ?? 0),
	}
}
