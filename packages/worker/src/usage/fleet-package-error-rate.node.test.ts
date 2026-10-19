import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	alignToUtcHour,
	buildFleetPackageErrorRateAnalyticsQuery,
	chooseFleetPackageErrorRateElevation,
	countsOf,
	detectFleetPackageErrorRateElevation,
	fleetPackageErrorRateMinDayEvents,
	foldAnalyticsWindowRows,
	parseFleetPackageErrorRateSnapshot,
	toWindowSnapshot,
} from './fleet-package-error-rate.ts'

function windowOf(
	kind: 'hour' | 'day',
	[recentEvents, recentErrors, previousEvents, previousErrors]: [
		number,
		number,
		number,
		number,
	],
) {
	const recentStart = new Date('2026-08-22T18:00:00.000Z')
	const snapshot = (start: Date, end: Date, events: number, errors: number) =>
		toWindowSnapshot({
			start,
			end,
			byMetric: {
				package_export: countsOf(events, errors),
				package_static_call: countsOf(0, 0),
				job_run: countsOf(0, 0),
				workflow_run: countsOf(0, 0),
			},
		})
	return {
		kind,
		recent: snapshot(
			recentStart,
			new Date('2026-08-22T19:00:00.000Z'),
			recentEvents,
			recentErrors,
		),
		previous: snapshot(
			new Date('2026-08-22T17:00:00.000Z'),
			recentStart,
			previousEvents,
			previousErrors,
		),
	}
}

test('fleet package error-rate detection stays anonymous and prefers day rises', () => {
	const detectionCases: Array<
		[[number, number, number, number], Record<string, string> | null]
	> = [
		[[10, 10, 100, 0], null],
		[[100, 4, 100, 1], null],
		[[100, 12, 100, 4], { reason: 'absolute_delta', kind: 'day' }],
		[[100, 8, 100, 4], { reason: 'relative_factor' }],
		[[80, 8, 80, 0], { reason: 'from_zero' }],
	]
	for (const [counts, want] of detectionCases) {
		const detected = detectFleetPackageErrorRateElevation({
			comparison: windowOf('day', counts),
			minEvents: fleetPackageErrorRateMinDayEvents,
		})
		expect(detected).toEqual(want && expect.objectContaining(want))
	}

	expect(
		chooseFleetPackageErrorRateElevation({
			day: windowOf('day', [80, 16, 80, 2]),
			hour: windowOf('hour', [40, 20, 40, 1]),
		})?.kind,
	).toBe('day')

	const query = buildFleetPackageErrorRateAnalyticsQuery({
		dataset: 'kody_usage_events',
		previousStart: new Date('2026-08-21T19:00:00.000Z'),
		recentStart: new Date('2026-08-22T19:00:00.000Z'),
		recentEnd: new Date('2026-08-22T20:00:00.000Z'),
	})
	expect(query).toContain(
		"blob2 IN ('package_export', 'package_static_call', 'job_run', 'workflow_run')",
	)
	expect(query).toContain(
		"sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count",
	)
	expect(query).not.toContain('caught')
	expect(query).toContain("toDateTime('2026-08-21 19:00:00')")
	expect(query).not.toContain('blob1')
	expect(query).not.toContain('user_id')

	// Concentration shares use the same real-failure filter: only blob4=error.
	const recentCombined = toWindowSnapshot({
		start: new Date('2026-08-22T18:00:00.000Z'),
		end: new Date('2026-08-22T19:00:00.000Z'),
		byMetric: {
			package_export: countsOf(10, 1),
			package_static_call: countsOf(100, 0),
			job_run: countsOf(0, 0),
			workflow_run: countsOf(0, 0),
		},
	})
	expect(recentCombined.combined).toEqual(countsOf(110, 1))
	expect(
		recentCombined.by_metric.find(
			(row) => row.metric === 'package_static_call',
		),
	).toEqual({
		metric: 'package_static_call',
		events: 100,
		errors: 0,
		rate: 0,
	})

	const snapshot = foldAnalyticsWindowRows(
		[
			{
				window: 'recent',
				metric: 'package_export',
				event_count: 10,
				error_count: 2,
			},
			{ window: 'previous', metric: 'job_run', event_count: 5, error_count: 1 },
		],
		{
			window: 'recent',
			start: new Date('2026-08-22T18:00:00.000Z'),
			end: new Date('2026-08-22T19:00:00.000Z'),
		},
	)
	expect(snapshot.combined).toEqual(countsOf(10, 2))
	expect(snapshot.by_metric.find((row) => row.metric === 'job_run')).toEqual({
		metric: 'job_run',
		events: 0,
		errors: 0,
		rate: null,
	})

	const snapshotHeader = {
		version: 1,
		updatedAt: '2026-08-22T19:00:00.000Z',
		environment: 'production',
	}
	expect(parseFleetPackageErrorRateSnapshot({ version: 2 })).toBeNull()
	expect(
		parseFleetPackageErrorRateSnapshot({
			...snapshotHeader,
			user_id: ownerIdFromStored('should-not-matter'),
		}),
	).toBeNull()
	expect(
		parseFleetPackageErrorRateSnapshot({
			...snapshotHeader,
			day: windowOf('day', [80, 16, 80, 2]),
			hour: windowOf('hour', [40, 2, 40, 1]),
			concentration: {
				kind: 'one_account',
				recent_errors: 90,
				owner_count: 1,
				package_count: 1,
				top_owner_share: 1,
				owners: [
					{
						username: 'jett',
						error_share: 1,
						packages: [{ kody_id: 'dji-cloud-relay-staging-deploy' }],
					},
				],
			},
		})?.concentration,
	).toMatchObject({ kind: 'one_account', owners: [{ username: 'jett' }] })
	expect(
		alignToUtcHour(new Date('2026-08-22T19:32:11.123Z')).toISOString(),
	).toBe('2026-08-22T19:00:00.000Z')
})
