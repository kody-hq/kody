/**
 * Daily failed counts follow opened incidents. Isolated ticks below the
 * consecutive-failure threshold stay in the 24h sample log only.
 */

import { incidentMinutesForDay, type IncidentSpan } from './day-bars.ts'
import type { ComponentDayStat } from './status-types.ts'

export const nonIncidentFailuresRetiredMetaKey =
	'non_incident_daily_failures_retired'

export type DailyFailedStat = {
	component: string
	day: string
	failed: number
}

export function dailyFailedIncrement(
	ok: boolean,
	statusAfter: 'operational' | 'down',
): 0 | 1 {
	return !ok && statusAfter === 'down' ? 1 : 0
}

export function daysToClearNonIncidentFailures(
	stats: ReadonlyArray<DailyFailedStat>,
	spansByComponent: ReadonlyMap<string, ReadonlyArray<IncidentSpan>>,
	now: number,
): Array<{ component: string; day: string }> {
	return stats.flatMap((row) => {
		if (row.failed <= 0) return []
		const minutes = incidentMinutesForDay(
			row.day,
			spansByComponent.get(row.component) ?? [],
			now,
		)
		return minutes === 0 ? [{ component: row.component, day: row.day }] : []
	})
}

export function utcDaysInSpan(
	startedAt: number,
	endedAt: number,
): Array<string> {
	const days: Array<string> = []
	const last = new Date(Math.max(startedAt, endedAt)).toISOString().slice(0, 10)
	let cursor = Date.parse(
		`${new Date(startedAt).toISOString().slice(0, 10)}T00:00:00.000Z`,
	)
	for (;;) {
		const day = new Date(cursor).toISOString().slice(0, 10)
		days.push(day)
		if (day >= last) return days
		cursor += 24 * 60 * 60 * 1000
	}
}

/**
 * Daily failed counts for the days a deleted incident covered. Days no other
 * incident covers drop to zero. Days shared with another incident subtract
 * the deleted span's failed samples. Samples only live for about a day, so
 * when they have been pruned (`removedFailedSamplesByDay` is null) the
 * subtraction falls back to the deleted span's minutes on that day, since
 * probes run once a minute.
 */
export function dailyFailedAfterIncidentDelete(input: {
	stats: ReadonlyArray<Omit<DailyFailedStat, 'component'>>
	deletedSpan: IncidentSpan
	removedFailedSamplesByDay: ReadonlyMap<string, number> | null
	remainingSpans: ReadonlyArray<IncidentSpan>
	now: number
}): Array<{ day: string; failed: number }> {
	return input.stats.map((row) => {
		const remainingMinutes = incidentMinutesForDay(
			row.day,
			input.remainingSpans,
			input.now,
		)
		if (remainingMinutes === 0) return { day: row.day, failed: 0 }
		const removed = input.removedFailedSamplesByDay
			? (input.removedFailedSamplesByDay.get(row.day) ?? 0)
			: incidentMinutesForDay(row.day, [input.deletedSpan], input.now)
		return { day: row.day, failed: Math.max(0, row.failed - removed) }
	})
}

export function daysFromFirstSample(
	days: ReadonlyArray<ComponentDayStat>,
): Array<ComponentDayStat> {
	const firstData = days.findIndex((day) => day.total > 0)
	if (firstData <= 0) return [...days]
	return days.slice(firstData)
}

export function uptimeWindowLabel(
	days: ReadonlyArray<ComponentDayStat>,
): string {
	const measured = days.filter((day) => day.total > 0).length
	if (measured === 0) return 'no data yet'
	if (measured >= 90) return '90 days'
	return `${measured} days`
}
