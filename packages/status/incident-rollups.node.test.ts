import { expect, test } from 'vitest'
import type { IncidentSpan } from './day-bars.ts'
import {
	dailyFailedAfterIncidentDelete,
	dailyFailedIncrement,
	daysFromFirstSample,
	daysToClearNonIncidentFailures,
	uptimeWindowLabel,
	utcDaysInSpan,
} from './incident-rollups.ts'
import type { ComponentDayStat } from './status-types.ts'

function day(overrides: Partial<ComponentDayStat> = {}): ComponentDayStat {
	return {
		day: '2026-08-19',
		total: 1440,
		failed: 0,
		incidentMinutes: 0,
		...overrides,
	}
}

test('rollups count only incident-state failures and drop empty leading days', () => {
	expect(dailyFailedIncrement(true, 'operational')).toBe(0)
	expect(dailyFailedIncrement(false, 'operational')).toBe(0)
	expect(dailyFailedIncrement(false, 'down')).toBe(1)
	expect(dailyFailedIncrement(true, 'down')).toBe(0)

	const now = Date.parse('2026-08-12T12:00:00.000Z')
	const spans = new Map<string, Array<IncidentSpan>>([
		[
			'package_apps',
			[
				{
					startedAt: Date.parse('2026-08-12T00:20:00.000Z'),
					resolvedAt: Date.parse('2026-08-12T00:26:00.000Z'),
				},
			],
		],
	])
	expect(
		daysToClearNonIncidentFailures(
			[
				{ component: 'app_db', day: '2026-08-12', failed: 2 },
				{ component: 'package_apps', day: '2026-08-12', failed: 6 },
				{ component: 'assets', day: '2026-08-14', failed: 1 },
				{ component: 'kv', day: '2026-08-12', failed: 0 },
			],
			spans,
			now,
		),
	).toEqual([
		{ component: 'app_db', day: '2026-08-12' },
		{ component: 'assets', day: '2026-08-14' },
	])

	expect(
		utcDaysInSpan(
			Date.parse('2026-10-11T23:59:00.000Z'),
			Date.parse('2026-10-13T00:01:00.000Z'),
		),
	).toEqual(['2026-10-11', '2026-10-12', '2026-10-13'])
	expect(
		utcDaysInSpan(
			Date.parse('2026-10-12T13:21:14.333Z'),
			Date.parse('2026-10-12T13:22:11.371Z'),
		),
	).toEqual(['2026-10-12'])
	const deletedSpan = {
		startedAt: Date.parse('2026-08-11T23:58:00.000Z'),
		resolvedAt: Date.parse('2026-08-12T00:03:00.000Z'),
	}
	expect(
		dailyFailedAfterIncidentDelete({
			stats: [
				{ day: '2026-08-11', failed: 4 },
				{ day: '2026-08-12', failed: 9 },
			],
			deletedSpan,
			removedFailedSamplesByDay: new Map([
				['2026-08-11', 4],
				['2026-08-12', 2],
			]),
			remainingSpans: spans.get('package_apps')!,
			now,
		}),
	).toEqual([
		{ day: '2026-08-11', failed: 0 },
		{ day: '2026-08-12', failed: 7 },
	])
	expect(
		dailyFailedAfterIncidentDelete({
			stats: [{ day: '2026-08-12', failed: 9 }],
			deletedSpan,
			removedFailedSamplesByDay: null,
			remainingSpans: spans.get('package_apps')!,
			now,
		}),
	).toEqual([{ day: '2026-08-12', failed: 6 }])

	const padded = [
		day({ day: '2026-05-22', total: 0 }),
		day({ day: '2026-08-05', total: 1420 }),
		day({ day: '2026-08-19', total: 1417 }),
	]
	expect(daysFromFirstSample(padded).map((entry) => entry.day)).toEqual([
		'2026-08-05',
		'2026-08-19',
	])
	expect(daysFromFirstSample(padded.slice(1))).toEqual(padded.slice(1))
	expect(uptimeWindowLabel(padded)).toBe('2 days')
	expect(uptimeWindowLabel([day({ total: 0 })])).toBe('no data yet')
	expect(
		uptimeWindowLabel(
			Array.from({ length: 90 }, (_, index) =>
				day({ day: `2026-05-${String(index + 1).padStart(2, '0')}` }),
			),
		),
	).toBe('90 days')
})
