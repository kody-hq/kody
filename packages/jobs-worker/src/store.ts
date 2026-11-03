import {
	createD1JobsStore,
	type JobsStore,
} from '@kody-internal/shared/jobs/store.ts'
import type { JobsWorkerEnv } from './env.ts'

export function jobsStore(env: JobsWorkerEnv): JobsStore {
	return createD1JobsStore(env.JOBS_DB)
}

/**
 * Next job the per-user scheduler should wake for (mirrors the pre-extraction
 * `getNextRunnableJob` in the main worker's jobs service): expired rows are
 * disabled first so they can never arm an alarm.
 */
export async function getNextRunnableJob(input: {
	env: JobsWorkerEnv
	userId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const store = jobsStore(input.env)
	await store.disableExpiredJobsForUser({ userId: input.userId, nowIso })
	const row = await store.getNextRunnableJob({ userId: input.userId, nowIso })
	return row
		? {
				...row.record,
				nextRunAt: row.schedulerWakeAt,
			}
		: null
}

export async function getWorkerStateValue(
	db: D1Database,
	key: string,
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT value FROM jobs_worker_state WHERE key = ?`)
		.bind(key)
		.first<{ value: string }>()
	return row?.value ?? null
}

export async function putWorkerStateValue(
	db: D1Database,
	key: string,
	value: string,
) {
	await db
		.prepare(
			`INSERT INTO jobs_worker_state (key, value, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, new Date().toISOString())
		.run()
}
