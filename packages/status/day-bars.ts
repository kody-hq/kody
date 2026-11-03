/**
 * 90-day status bars follow opened incidents, not raw probe failures.
 * Isolated ticks below the consecutive-failure threshold stay green.
 */

import type { ComponentDayStat } from './status-types.ts'

export type IncidentSpan = {
	startedAt: number
	resolvedAt: number | null
}

export type DayBarKind = 'empty' | 'ok' | 'partial' | 'bad'

const dayMs = 24 * 60 * 60 * 1000
const minuteMs = 60_000
const majorIncidentMinutes = 60
const majorFailedRatio = 0.05

function utcDayStartMs(day: string): number {
	return Date.parse(`${day}T00:00:00.000Z`)
}

export function incidentMinutesForDay(
	day: string,
	spans: ReadonlyArray<IncidentSpan>,
	now: number,
): number {
	const dayStart = utcDayStartMs(day)
	if (!Number.isFinite(dayStart)) return 0
	const dayEnd = dayStart + dayMs
	let overlapMs = 0
	for (const span of spans) {
		const end = span.resolvedAt ?? now
		overlapMs += Math.max(
			0,
			Math.min(end, dayEnd) - Math.max(span.startedAt, dayStart),
		)
	}
	if (overlapMs <= 0) return 0
	return Math.max(1, Math.floor(overlapMs / minuteMs))
}

export function dayBarKind(day: ComponentDayStat): DayBarKind {
	if (day.total === 0) return 'empty'
	if (day.incidentMinutes === 0) return 'ok'
	const failedRatio = day.failed / day.total
	if (
		failedRatio >= majorFailedRatio ||
		day.incidentMinutes >= majorIncidentMinutes
	) {
		return 'bad'
	}
	return 'partial'
}

export function dayBarClassName(kind: DayBarKind): string {
	switch (kind) {
		case 'ok':
			return 'bar'
		case 'empty':
			return 'bar empty'
		case 'partial':
			return 'bar partial'
		case 'bad':
			return 'bar bad'
		default: {
			kind satisfies never
			throw new Error(`Unknown day bar kind: ${String(kind)}`)
		}
	}
}

export function dayBarTitle(day: ComponentDayStat): string {
	const kind = dayBarKind(day)
	switch (kind) {
		case 'empty':
			return `${day.day}: no data`
		case 'ok': {
			if (day.failed === 0) return `${day.day}: 100% up`
			const noun = day.failed === 1 ? 'failure' : 'failures'
			return `${day.day}: ${day.failed} isolated probe ${noun}, no incident`
		}
		case 'partial':
		case 'bad': {
			const pct = (((day.total - day.failed) / day.total) * 100).toFixed(2)
			return `${day.day}: ${day.incidentMinutes} min incident · ${pct}% up`
		}
		default: {
			kind satisfies never
			throw new Error(`Unknown day bar kind: ${String(kind)}`)
		}
	}
}
