import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	userMeterDailyCounterRetentionDays,
	type UserMeterDailyTrendResult,
} from '#worker/entitlements/user-meter-do.ts'
import {
	type UserMeterEnv,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'

/** How many UTC months of `usage_rollups` to include when cheap to read. */
export const usageTrendMonthHistoryMonths = 12

const usageTrendMonthMetrics = ['execute', 'dynamic_worker_day'] as const

export type UsageTrendDay = {
	/** UTC day key (`YYYY-MM-DD`). */
	day: string
	/** Hosted MCP execute count for that UTC day. */
	execute: number
	/** Unique Dynamic Worker first-claim count for that UTC day. */
	uniqueWorkerDays: number
	/** Job runs recorded in UserMeter that UTC day. */
	jobRuns: number
	/** Automation invocations recorded in UserMeter that UTC day. */
	automationInvocations: number
}

export type UsageTrendMonth = {
	/** UTC month key (`YYYY-MM`). */
	month: string
	execute: number
	uniqueWorkerDays: number
}

export type UsageTrend = {
	days: Array<UsageTrendDay>
	months: Array<UsageTrendMonth>
	retentionDays: number
	asOf: string
}

/**
 * Build a contiguous UTC-day series from a UserMeter {@link readDailyTrend}
 * result. Missing counters and unique-worker-day rows count as zero.
 */
export function toUsageTrendDays(
	trend: UserMeterDailyTrendResult,
): Array<UsageTrendDay> {
	const executeByDay = new Map(
		trend.executeCalls.map((row) => [row.day, row.count]),
	)
	const jobRunsByDay = new Map<string, number>()
	const automationByDay = new Map<string, number>()
	for (const row of trend.counters) {
		switch (row.resource) {
			case 'job_runs_per_day':
				jobRunsByDay.set(row.day, row.count)
				break
			case 'automation_invocations_per_day':
				automationByDay.set(row.day, row.count)
				break
			case 'execute_unique_workers_per_day':
			case 'email_sends_per_day':
			case 'email_receives_per_day':
			case 'outbound_fetches_per_day':
				break
			default: {
				const _exhaustive: never = row.resource
				void _exhaustive
				break
			}
		}
	}
	const uniqueWorkerDaysByDay = new Map(
		trend.uniqueWorkerDays.map((row) => [row.day, row.count]),
	)
	const days: Array<UsageTrendDay> = []
	const cursor = new Date(`${trend.startDay}T00:00:00.000Z`)
	const end = new Date(`${trend.endDay}T00:00:00.000Z`)
	while (cursor.getTime() <= end.getTime()) {
		const day = utcDayKey(cursor)
		days.push({
			day,
			execute: executeByDay.get(day) ?? 0,
			uniqueWorkerDays: uniqueWorkerDaysByDay.get(day) ?? 0,
			jobRuns: jobRunsByDay.get(day) ?? 0,
			automationInvocations: automationByDay.get(day) ?? 0,
		})
		cursor.setUTCDate(cursor.getUTCDate() + 1)
	}
	return days
}

/**
 * Signed-in usage trend: UserMeter daily series (retention window) plus cheap
 * monthly rollups from D1 `usage_rollups`. Does not touch Analytics Engine.
 */
export async function readAccountUsageTrend(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	now?: Date
}): Promise<UsageTrend> {
	const now = input.now ?? new Date()
	const asOf = now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	const [dailyTrend, monthRows] = await Promise.all([
		meter.readDailyTrend({ now: asOf }),
		queryUsageTrendMonthRollups({
			db: input.db,
			userId: input.userId,
			now,
		}),
	])
	return {
		days: toUsageTrendDays(dailyTrend),
		months: monthRows,
		retentionDays:
			dailyTrend.retentionDays || userMeterDailyCounterRetentionDays,
		asOf,
	}
}

async function queryUsageTrendMonthRollups(input: {
	db: D1Database
	userId: string
	now: Date
}): Promise<Array<UsageTrendMonth>> {
	const placeholders = usageTrendMonthMetrics.map(() => '?').join(', ')
	const result = await input.db
		.prepare(
			`SELECT month, metric, event_count
			 FROM usage_rollups
			 WHERE user_id = ?
				AND metric IN (${placeholders})
			 ORDER BY month DESC, metric ASC`,
		)
		.bind(input.userId, ...usageTrendMonthMetrics)
		.all<{ month: string; metric: string; event_count: number }>()

	const byMonth = new Map<string, UsageTrendMonth>()
	for (const row of result.results ?? []) {
		const month = String(row.month)
		const existing = byMonth.get(month) ?? {
			month,
			execute: 0,
			uniqueWorkerDays: 0,
		}
		const count = Math.max(0, Number(row.event_count ?? 0))
		if (row.metric === 'execute') {
			existing.execute = count
		} else if (row.metric === 'dynamic_worker_day') {
			existing.uniqueWorkerDays = count
		}
		byMonth.set(month, existing)
	}

	const monthsNewestFirst: Array<UsageTrendMonth> = []
	const cursor = new Date(
		Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1),
	)
	for (let index = 0; index < usageTrendMonthHistoryMonths; index += 1) {
		const month = utcMonthKey(cursor)
		monthsNewestFirst.push(
			byMonth.get(month) ?? {
				month,
				execute: 0,
				uniqueWorkerDays: 0,
			},
		)
		cursor.setUTCMonth(cursor.getUTCMonth() - 1)
	}
	// Oldest → newest so chart series match the daily window.
	return monthsNewestFirst.reverse()
}
