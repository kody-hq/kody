import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import {
	claimJobRow,
	disableExpiredJobRowsForUser,
	finalizeClaimedJobRow,
	getJobRowById,
	getNextRunnableJobRow,
	jobExecutionLeaseMs,
	listDueJobRows,
	maxDueJobsPerAlarm,
	recordJobRunNowOutcomeRow,
	refreshPackageJobRowIdentity,
	renewClaimedJobRow,
	retryClaimedJobRow,
	updateJobRow,
} from '@kody-internal/shared/jobs/repo.ts'

async function ensureJobsSchema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT,
			repo_check_policy_json TEXT,
			storage_id TEXT NOT NULL,
			params_json TEXT,
			schedule_json TEXT NOT NULL,
			timezone TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
			expires_at TEXT,
			caller_context_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			next_run_at TEXT NOT NULL,
			claim_token TEXT,
			running_since TEXT,
			lease_expires_at TEXT,
			claimed_scheduled_for TEXT,
			retry_scheduled_for TEXT,
			retry_count INTEGER NOT NULL DEFAULT 0,
			last_completed_scheduled_for TEXT,
			disabled_reason TEXT,
			deleted_at TEXT
		)`,
	).run()
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE jobs ADD COLUMN expires_at TEXT`,
		).run()
	} catch {
		// Column already present when migrations or a prior CREATE included it.
	}
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE jobs ADD COLUMN disabled_reason TEXT`,
		).run()
	} catch {
		// Column already present when a prior CREATE included it.
	}
	await ensureSoftDeleteTestColumns(env.APP_DB, ['jobs'])
	await env.APP_DB.prepare(`DELETE FROM jobs`).run()
}

async function insertJob(input: {
	id: string
	userId: string
	nextRunAt: string
	enabled?: boolean
	killSwitchEnabled?: boolean
	expiresAt?: string | null
}) {
	const now = '2026-04-20T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			enabled, kill_switch_enabled, expires_at, caller_context_json, created_at,
			updated_at, next_run_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.userId,
			input.id,
			`source-${input.id}`,
			`job:${input.id}`,
			JSON.stringify({ type: 'interval', every: '1h' }),
			'UTC',
			input.enabled === false ? 0 : 1,
			input.killSwitchEnabled === true ? 1 : 0,
			input.expiresAt ?? null,
			now,
			now,
			input.nextRunAt,
		)
		.run()
}

function claim(userId: string, jobId: string, now: Date, claimToken: string) {
	return claimJobRow({ db: env.APP_DB, userId, jobId, now, claimToken })
}

async function dueIds(userId: string, nowIso: string) {
	return (await listDueJobRows(env.APP_DB, userId, nowIso)).map((row) => row.id)
}

test('listDueJobRows caps a due-job backlog at maxDueJobsPerAlarm, oldest first', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-due-limit')
	const nowIso = '2026-04-20T12:00:00.000Z'
	const dueAt = '2026-04-20T00:00:00.000Z'
	const backlogSize = maxDueJobsPerAlarm + 5
	const dueId = (index: number) => `due-${String(index).padStart(3, '0')}`
	for (let index = 0; index < backlogSize; index += 1) {
		await insertJob({
			id: dueId(index),
			userId,
			nextRunAt: new Date(Date.parse(dueAt) + index * 60_000).toISOString(),
		})
	}
	// Rows that must never be picked up: other user, disabled, kill-switched,
	// expired, and not-yet-due jobs.
	for (const job of [
		{
			id: 'other-user',
			userId: ownerIdFromStored('user-other'),
			nextRunAt: dueAt,
		},
		{ id: 'disabled', userId, nextRunAt: dueAt, enabled: false },
		{ id: 'kill-switched', userId, nextRunAt: dueAt, killSwitchEnabled: true },
		{
			id: 'expired',
			userId,
			nextRunAt: dueAt,
			expiresAt: '2026-04-19T23:00:00.000Z',
		},
		{ id: 'future', userId, nextRunAt: '2026-04-21T00:00:00.000Z' },
	]) {
		await insertJob(job)
	}

	const firstBatch = await dueIds(userId, nowIso)
	expect(firstBatch).toEqual(
		Array.from({ length: maxDueJobsPerAlarm }, (_, index) => dueId(index)),
	)

	// Once the first batch has been rescheduled out of the due window, the next
	// alarm invocation picks up the remainder of the backlog.
	for (const id of firstBatch) {
		await env.APP_DB.prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`)
			.bind('2026-04-22T00:00:00.000Z', id)
			.run()
	}
	expect(await dueIds(userId, nowIso)).toEqual(
		Array.from({ length: backlogSize - maxDueJobsPerAlarm }, (_, index) =>
			dueId(maxDueJobsPerAlarm + index),
		),
	)
})

test('conditional job claims exclude overlap and reclaim only after lease expiry', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-claim')
	const jobId = 'claimed-job'
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	const now = new Date(scheduledFor)
	await insertJob({ id: jobId, userId, nextRunAt: scheduledFor })

	const [first, overlap] = await Promise.all([
		claim(userId, jobId, now, 'claim-first'),
		claim(userId, jobId, now, 'claim-overlap'),
	])
	const winner = first ?? overlap
	expect(winner).not.toBeNull()
	expect([first, overlap].filter(Boolean)).toHaveLength(1)
	expect(winner?.claimed_scheduled_for).toBe(scheduledFor)
	expect(winner?.lease_expires_at).toBe(
		new Date(now.valueOf() + jobExecutionLeaseMs).toISOString(),
	)

	expect(
		await dueIds(
			userId,
			new Date(now.valueOf() + jobExecutionLeaseMs - 1).toISOString(),
		),
	).toEqual([])
	const nextWhileLeased = await getNextRunnableJobRow(
		env.APP_DB,
		userId,
		now.toISOString(),
	)
	expect(nextWhileLeased?.schedulerWakeAt).toBe(winner?.lease_expires_at)

	const renew = (claimToken: string, nowMs: number) =>
		renewClaimedJobRow({ db: env.APP_DB, userId, jobId, claimToken, nowMs })
	const renewedAtMs = now.valueOf() + jobExecutionLeaseMs / 2
	expect(await renew('claim-stale', renewedAtMs)).toBe(false)
	expect(await renew(winner?.claim_token ?? '', renewedAtMs)).toBe(true)
	expect(
		await claim(
			userId,
			jobId,
			new Date(now.valueOf() + jobExecutionLeaseMs),
			'claim-too-early',
		),
	).toBeNull()

	const reclaimed = await claim(
		userId,
		jobId,
		new Date(renewedAtMs + jobExecutionLeaseMs),
		'claim-reclaimed',
	)
	expect(reclaimed?.claim_token).toBe('claim-reclaimed')
	expect(reclaimed?.claimed_scheduled_for).toBe(scheduledFor)

	const retryAt = '2026-04-20T12:10:05.000Z'
	expect(
		await retryClaimedJobRow({
			db: env.APP_DB,
			userId,
			jobId,
			claimToken: 'claim-reclaimed',
			nextRunAt: retryAt,
		}),
	).toBe(true)
	expect(
		await getNextRunnableJobRow(env.APP_DB, userId, '2026-04-20T12:10:00.000Z'),
	).toMatchObject({
		claim_token: null,
		retry_scheduled_for: scheduledFor,
		retry_count: 1,
		schedulerWakeAt: retryAt,
	})
	const retriedOccurrence = await claim(
		userId,
		jobId,
		new Date(retryAt),
		'claim-retry',
	)
	expect(retriedOccurrence?.claimed_scheduled_for).toBe(scheduledFor)
	expect(retriedOccurrence?.retry_count).toBe(1)
})

test('job writes retain D1 run anchors and default RunLog-owned fields', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-run-anchors')
	const jobId = 'run-anchors'
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	await insertJob({ id: jobId, userId, nextRunAt: scheduledFor })
	const row = await getJobRowById(env.APP_DB, userId, jobId)
	if (!row) throw new Error('Expected job row.')
	const runLogDefaults = { runCount: 0, successCount: 0, errorCount: 0 }

	const finishedAt = '2026-04-20T12:05:00.000Z'
	expect(
		await updateJobRow({
			db: env.APP_DB,
			userId,
			job: {
				...row.record,
				updatedAt: finishedAt,
				lastRunAt: finishedAt,
				lastRunStatus: 'success',
				lastRunError: 'RunLog-only error',
				lastDurationMs: 999,
				runCount: 99,
				successCount: 99,
				errorCount: 99,
			},
			callerContextJson: row.callerContextJson,
		}),
	).toBe(true)

	const updated = await getJobRowById(env.APP_DB, userId, jobId)
	expect(updated).toMatchObject({
		last_run_at: finishedAt,
		last_run_status: 'success',
		record: {
			lastRunAt: finishedAt,
			lastRunStatus: 'success',
			...runLogDefaults,
		},
	})
	expect(updated).not.toHaveProperty('last_run_error')
	expect(updated).not.toHaveProperty('last_duration_ms')
	expect(updated?.record.lastRunError).toBeUndefined()
	expect(updated?.record.lastDurationMs).toBeUndefined()

	const claimed = await claim(
		userId,
		jobId,
		new Date('2026-04-20T12:10:00.000Z'),
		'claim-run-anchors',
	)
	if (!claimed) throw new Error('Expected job claim.')
	const refreshedCallerContextJson = JSON.stringify({
		user: { userId, email: 'refreshed@example.com' },
	})
	expect(
		await refreshPackageJobRowIdentity({
			db: env.APP_DB,
			userId,
			jobId: claimed.id,
			sourceId: 'refreshed-source',
			publishedCommit: 'refreshed-commit',
			callerContextJson: refreshedCallerContextJson,
			updatedAt: '2026-04-20T12:10:02.000Z',
		}),
	).toBe(true)
	const finalizedAt = '2026-04-20T12:10:05.000Z'
	expect(
		await finalizeClaimedJobRow({
			db: env.APP_DB,
			userId,
			job: {
				...claimed.record,
				updatedAt: finalizedAt,
				lastRunAt: finalizedAt,
				lastRunStatus: 'error',
			},
			claimToken: 'claim-run-anchors',
			scheduledFor,
		}),
	).toBe(true)
	expect(await getJobRowById(env.APP_DB, userId, jobId)).toMatchObject({
		last_run_at: finalizedAt,
		last_run_status: 'error',
		last_completed_scheduled_for: scheduledFor,
		source_id: 'refreshed-source',
		published_commit: 'refreshed-commit',
		caller_context_json: refreshedCallerContextJson,
		record: {
			lastRunAt: finalizedAt,
			lastRunStatus: 'error',
			lastRunError: undefined,
			lastDurationMs: undefined,
			...runLogDefaults,
		},
	})
})

test('ordinary updates cancel claims and completed occurrence guards fence malformed due rows', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-fencing')
	const scheduledFor = '2026-04-20T12:00:00.000Z'
	await insertJob({ id: 'cancelled-claim', userId, nextRunAt: scheduledFor })
	const claimed = await claim(
		userId,
		'cancelled-claim',
		new Date(scheduledFor),
		'stale-token',
	)
	if (!claimed) throw new Error('Expected job claim.')

	expect(
		await updateJobRow({
			db: env.APP_DB,
			userId,
			job: { ...claimed.record, name: 'Edited while claimed' },
			callerContextJson: claimed.callerContextJson,
		}),
	).toBe(true)
	expect(await getJobRowById(env.APP_DB, userId, claimed.id)).toMatchObject({
		name: 'Edited while claimed',
		claim_token: null,
		running_since: null,
		lease_expires_at: null,
		claimed_scheduled_for: null,
		retry_scheduled_for: null,
		retry_count: 0,
	})
	expect(
		await finalizeClaimedJobRow({
			db: env.APP_DB,
			userId,
			job: claimed.record,
			claimToken: 'stale-token',
			scheduledFor,
		}),
	).toBe(false)

	await insertJob({ id: 'already-completed', userId, nextRunAt: scheduledFor })
	await env.APP_DB.prepare(
		`UPDATE jobs SET last_completed_scheduled_for = ? WHERE id = ? AND user_id = ?`,
	)
		.bind(scheduledFor, 'already-completed', userId)
		.run()
	expect(await dueIds(userId, scheduledFor)).not.toContain('already-completed')
	expect(
		await claim(
			userId,
			'already-completed',
			new Date(scheduledFor),
			'must-not-claim',
		),
	).toBeNull()
})

test('expired jobs are skipped by due/claim/next-runnable, wake the scheduler at expires_at, and disableExpired flips enabled', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-expires')
	const nowIso = '2026-04-20T12:00:00.000Z'
	const dueAt = '2026-04-20T11:00:00.000Z'
	await insertJob({
		id: 'still-valid',
		userId,
		nextRunAt: dueAt,
		expiresAt: '2026-04-20T13:00:00.000Z',
	})
	await insertJob({
		id: 'already-expired',
		userId,
		nextRunAt: dueAt,
		expiresAt: '2026-04-20T11:30:00.000Z',
	})
	await insertJob({ id: 'no-expiry', userId, nextRunAt: dueAt })

	expect((await dueIds(userId, nowIso)).sort()).toEqual([
		'no-expiry',
		'still-valid',
	])
	expect(
		await claim(userId, 'already-expired', new Date(nowIso), 'should-fail'),
	).toBeNull()
	expect((await getNextRunnableJobRow(env.APP_DB, userId, nowIso))?.id).toBe(
		'no-expiry',
	)

	expect(
		await disableExpiredJobRowsForUser({ db: env.APP_DB, userId, nowIso }),
	).toBe(1)
	const disabled = await getJobRowById(env.APP_DB, userId, 'already-expired')
	expect(disabled).toMatchObject({
		enabled: 0,
		expires_at: '2026-04-20T11:30:00.000Z',
	})
	expect(disabled?.record.expiresAt).toBe('2026-04-20T11:30:00.000Z')

	const wakeUserId = 'user-expires-wake'
	await insertJob({
		id: 'expires-before-run',
		userId: wakeUserId,
		nextRunAt: '2026-04-21T12:00:00.000Z',
		expiresAt: '2026-04-20T18:00:00.000Z',
	})
	expect(
		await getNextRunnableJobRow(env.APP_DB, wakeUserId, nowIso),
	).toMatchObject({
		id: 'expires-before-run',
		schedulerWakeAt: '2026-04-20T18:00:00.000Z',
	})
})

test('Run now outcomes keep settings edited during the run and move next_run_at only on the same schedule', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-run-now-outcome')
	await insertJob({
		id: 'run-now-outcome',
		userId,
		nextRunAt: '2026-04-20T12:00:00.000Z',
	})
	const before = await getJobRowById(env.APP_DB, userId, 'run-now-outcome')
	if (!before) throw new Error('Expected job.')
	const ranUnder = {
		scheduleJson: before.schedule_json,
		timezone: before.timezone,
	}
	await updateJobRow({
		db: env.APP_DB,
		userId,
		job: { ...before.record, enabled: false, name: 'Turned off mid-run' },
		callerContextJson: before.callerContextJson,
	})

	expect(
		await recordJobRunNowOutcomeRow({
			db: env.APP_DB,
			userId,
			jobId: 'run-now-outcome',
			lastRunAt: '2026-04-20T11:05:00.000Z',
			lastRunStatus: 'success',
			updatedAt: '2026-04-20T11:05:00.000Z',
			nextRunAt: '2026-04-20T11:20:00.000Z',
			...ranUnder,
		}),
	).toBe(true)
	expect(
		await getJobRowById(env.APP_DB, userId, 'run-now-outcome'),
	).toMatchObject({
		name: 'Turned off mid-run',
		enabled: 0,
		last_run_at: '2026-04-20T11:05:00.000Z',
		last_run_status: 'success',
		next_run_at: '2026-04-20T11:20:00.000Z',
	})

	await env.APP_DB.prepare(
		`UPDATE jobs SET schedule_json = ? WHERE id = ? AND user_id = ?`,
	)
		.bind('{"type":"interval","every":"2h"}', 'run-now-outcome', userId)
		.run()
	await recordJobRunNowOutcomeRow({
		db: env.APP_DB,
		userId,
		jobId: 'run-now-outcome',
		lastRunAt: '2026-04-20T11:10:00.000Z',
		lastRunStatus: 'error',
		updatedAt: '2026-04-20T11:10:00.000Z',
		nextRunAt: '2026-04-20T11:25:00.000Z',
		...ranUnder,
	})
	expect(
		await getJobRowById(env.APP_DB, userId, 'run-now-outcome'),
	).toMatchObject({
		last_run_status: 'error',
		next_run_at: '2026-04-20T11:20:00.000Z',
	})
})

test('a Run now outcome leaves a scheduled claim taken during the run in place', async () => {
	await ensureJobsSchema()
	const userId = ownerIdFromStored('user-run-now-claim')
	await insertJob({
		id: 'run-now-claim',
		userId,
		nextRunAt: '2026-04-20T11:00:00.000Z',
	})
	const before = await getJobRowById(env.APP_DB, userId, 'run-now-claim')
	if (!before) throw new Error('Expected job.')
	const claimed = await claim(
		userId,
		'run-now-claim',
		new Date('2026-04-20T11:01:00.000Z'),
		'claim-scheduled',
	)
	expect(claimed?.claim_token).toBe('claim-scheduled')

	await recordJobRunNowOutcomeRow({
		db: env.APP_DB,
		userId,
		jobId: 'run-now-claim',
		lastRunAt: '2026-04-20T11:02:00.000Z',
		lastRunStatus: 'success',
		updatedAt: '2026-04-20T11:02:00.000Z',
		nextRunAt: '2026-04-20T11:17:00.000Z',
		scheduleJson: before.schedule_json,
		timezone: before.timezone,
	})
	expect(
		await getJobRowById(env.APP_DB, userId, 'run-now-claim'),
	).toMatchObject({
		claim_token: 'claim-scheduled',
		claimed_scheduled_for: claimed?.claimed_scheduled_for,
		last_run_status: 'success',
	})
})
