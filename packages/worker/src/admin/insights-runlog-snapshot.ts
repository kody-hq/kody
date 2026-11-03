/**
 * Hourly KV snapshot of RunLog-derived admin insights. The insights page
 * reads this instead of fanning out per-user Durable Object RPCs.
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RunLogAdminInsightsSnapshot } from '#worker/run-records/admin-insights-snapshot.ts'
import { getAdminInsightsSnapshot } from '#worker/run-records/service.ts'
import type {
	AdminInsightsRunLogCompleteness,
	AdminInsightsWorkflowStatus,
} from '#universal/loader-data.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const adminInsightsRunLogSnapshotKvKey = 'admin-insights-runlog:v1'

/**
 * Per-user RunLog point-reads for workflow/activation aggregates. Concurrent
 * RPCs stay at 8. Each hourly tick also caps how many users it fans out to
 * so the scheduled invocation cannot exhaust the Worker subrequest budget.
 * Overflow marks the snapshot incomplete instead of paging across ticks.
 */
export const adminInsightsRunLogConcurrency = 8
export const adminInsightsRunLogMaxUsersPerTick = 1_500

const hourMs = 60 * 60 * 1000

type InsightsUserRow = {
	stable_user_id: OwnerId
	email_verified_at: string | null
}

export type AggregatedRunLogInsights = AdminInsightsRunLogCompleteness & {
	workflowStatuses: Array<AdminInsightsWorkflowStatus>
	workflowRuns: number
	jobSuccessRuns: number
	jobErrorRuns: number
	packageRunSucceededUsers: number
	packageActivatedUsers: number
	medianHoursToActivation: number | null
}

export type AdminInsightsRunLogSnapshot = AggregatedRunLogInsights & {
	version: 1
}

export const emptyRunLogInsights: AggregatedRunLogInsights = {
	usersAttempted: 0,
	usersLoaded: 0,
	complete: true,
	snapshotUpdatedAt: null,
	workflowStatuses: [],
	workflowRuns: 0,
	jobSuccessRuns: 0,
	jobErrorRuns: 0,
	packageRunSucceededUsers: 0,
	packageActivatedUsers: 0,
	medianHoursToActivation: null,
}

export function missingRunLogInsights(): AggregatedRunLogInsights {
	return {
		...emptyRunLogInsights,
		complete: false,
	}
}

export async function readAdminInsightsRunLogSnapshot(
	kv: KVNamespace | undefined,
): Promise<AggregatedRunLogInsights> {
	if (!kv) return missingRunLogInsights()
	try {
		const snapshot = await kv.get<AdminInsightsRunLogSnapshot>(
			adminInsightsRunLogSnapshotKvKey,
			'json',
		)
		if (!snapshot || snapshot.version !== 1) return missingRunLogInsights()
		return {
			usersAttempted: snapshot.usersAttempted,
			usersLoaded: snapshot.usersLoaded,
			complete: snapshot.complete,
			snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
			workflowStatuses: snapshot.workflowStatuses,
			workflowRuns: snapshot.workflowRuns,
			jobSuccessRuns: snapshot.jobSuccessRuns,
			jobErrorRuns: snapshot.jobErrorRuns,
			packageRunSucceededUsers: snapshot.packageRunSucceededUsers,
			packageActivatedUsers: snapshot.packageActivatedUsers,
			medianHoursToActivation: snapshot.medianHoursToActivation,
		}
	} catch (error) {
		console.warn('admin-insights-run-log-snapshot-read-failed', { error })
		return missingRunLogInsights()
	}
}

export async function refreshAdminInsightsRunLogSnapshot(input: {
	env: Env
	now?: Date
}): Promise<AggregatedRunLogInsights> {
	const { users, truncated } = await listNonDeletingInsightsUsers(
		input.env.APP_DB,
	)
	const aggregated = await aggregateRunLogInsights({
		env: input.env,
		users,
	})
	const snapshot: AdminInsightsRunLogSnapshot = {
		version: 1,
		...aggregated,
		complete: aggregated.complete && !truncated,
		snapshotUpdatedAt: (input.now ?? new Date()).toISOString(),
	}
	if (!input.env.BUNDLE_ARTIFACTS_KV) {
		throw new Error('BUNDLE_ARTIFACTS_KV is required for RunLog snapshots.')
	}
	await input.env.BUNDLE_ARTIFACTS_KV.put(
		adminInsightsRunLogSnapshotKvKey,
		JSON.stringify(snapshot),
	)
	return {
		...aggregated,
		complete: snapshot.complete,
		snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
	}
}

async function listNonDeletingInsightsUsers(db: D1Database): Promise<{
	users: Array<InsightsUserRow>
	truncated: boolean
}> {
	const rows = await db
		.prepare(
			`SELECT stable_user_id, email_verified_at
			 FROM users
			 WHERE deleting_at IS NULL
			   AND stable_user_id IS NOT NULL${andLiveDeletedAtSql()}
			 ORDER BY stable_user_id LIMIT ?`,
		)
		.bind(adminInsightsRunLogMaxUsersPerTick + 1)
		.all<InsightsUserRow>()
	const eligible = (rows.results ?? []).filter(
		(row) =>
			typeof row.stable_user_id === 'string' && row.stable_user_id !== '',
	)
	const truncated = eligible.length > adminInsightsRunLogMaxUsersPerTick
	return {
		users: truncated
			? eligible.slice(0, adminInsightsRunLogMaxUsersPerTick)
			: eligible,
		truncated,
	}
}

async function aggregateRunLogInsights(input: {
	env: Env
	users: ReadonlyArray<InsightsUserRow>
}): Promise<AggregatedRunLogInsights> {
	if (input.users.length === 0) return emptyRunLogInsights

	const snapshots = await mapWithConcurrency(
		input.users,
		adminInsightsRunLogConcurrency,
		async (user) => {
			try {
				const snapshot = await getAdminInsightsSnapshot({
					env: input.env,
					userId: user.stable_user_id,
				})
				return { user, snapshot }
			} catch (error) {
				// Missing RUN_LOG or a single-user RPC failure must not take down
				// the hourly snapshot — degrade run-derived charts for that user only.
				console.warn('admin-insights-run-log-unavailable', {
					userId: user.stable_user_id,
					error,
				})
				return { user, snapshot: null }
			}
		},
	)

	return foldRunLogSnapshots(snapshots)
}

export function foldRunLogSnapshots(
	entries: ReadonlyArray<{
		user: InsightsUserRow
		snapshot: RunLogAdminInsightsSnapshot | null
	}>,
): AggregatedRunLogInsights {
	const usersAttempted = entries.length
	let usersLoaded = 0
	const statusCounts = new Map<string, number>()
	let workflowRuns = 0
	let jobSuccessRuns = 0
	let jobErrorRuns = 0
	let packageRunSucceededUsers = 0
	let packageActivatedUsers = 0
	const activationHours: Array<number> = []

	for (const { user, snapshot } of entries) {
		if (!snapshot) continue
		usersLoaded += 1
		for (const row of snapshot.workflowStatusCounts) {
			const count = Number(row.count) || 0
			if (count <= 0) continue
			const status = row.status.trim() || 'unknown'
			statusCounts.set(status, (statusCounts.get(status) ?? 0) + count)
			workflowRuns += count
		}
		jobSuccessRuns += Math.max(0, Number(snapshot.jobRunCounts.success) || 0)
		jobErrorRuns += Math.max(0, Number(snapshot.jobRunCounts.error) || 0)
		let hasRunSucceeded = false
		let activatedReachedAt: string | null = null
		for (const milestone of snapshot.activationMilestones) {
			if (milestone.milestone === 'package_run_succeeded') {
				hasRunSucceeded = true
			} else if (milestone.milestone === 'package_activated') {
				activatedReachedAt = milestone.reachedAt
			}
		}
		if (hasRunSucceeded) packageRunSucceededUsers += 1
		if (activatedReachedAt != null) {
			packageActivatedUsers += 1
			const hours = hoursFromVerifiedToActivation(
				user.email_verified_at,
				activatedReachedAt,
			)
			if (hours != null) activationHours.push(hours)
		}
	}

	activationHours.sort((left, right) => left - right)

	return {
		usersAttempted,
		usersLoaded,
		complete: usersLoaded === usersAttempted,
		snapshotUpdatedAt: null,
		workflowStatuses: Array.from(statusCounts.entries())
			.map(([status, count]) => ({ status, count }))
			.sort(
				(left, right) =>
					right.count - left.count || left.status.localeCompare(right.status),
			),
		workflowRuns,
		jobSuccessRuns,
		jobErrorRuns,
		packageRunSucceededUsers,
		packageActivatedUsers,
		medianHoursToActivation: medianOf(activationHours),
	}
}

/**
 * Hours from email verification to package activation. Users who activated
 * before verifying (seeded / admin-created) would skew the median negative, so
 * they are excluded rather than clamped.
 */
export function hoursFromVerifiedToActivation(
	emailVerifiedAt: string | null | undefined,
	activatedReachedAt: string,
): number | null {
	if (emailVerifiedAt == null || emailVerifiedAt === '') return null
	const verifiedMs = Date.parse(emailVerifiedAt)
	const activatedMs = Date.parse(activatedReachedAt)
	if (!Number.isFinite(verifiedMs) || !Number.isFinite(activatedMs)) return null
	const hours = (activatedMs - verifiedMs) / hourMs
	if (!Number.isFinite(hours) || hours < 0) return null
	return hours
}

export async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<Array<R>> {
	if (items.length === 0) return []
	const limit = Math.max(1, Math.min(concurrency, items.length))
	const results: Array<R | undefined> = Array.from({ length: items.length })
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				results[index] = await mapper(item)
			}
		}),
	)
	return results as Array<R>
}

/** Median of an ascending list. Even-length lists average the middle pair. */
export function medianOf(sortedValues: Array<number>): number | null {
	const values = sortedValues.filter((value) => Number.isFinite(value))
	if (values.length === 0) return null
	const middle = Math.floor(values.length / 2)
	if (values.length % 2 === 1) return values[middle] ?? null
	const lower = values[middle - 1]
	const upper = values[middle]
	if (lower == null || upper == null) return null
	return (lower + upper) / 2
}
