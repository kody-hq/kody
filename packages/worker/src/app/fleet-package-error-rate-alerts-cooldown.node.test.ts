import { expect, test } from 'vitest'
import {
	fleetPackageErrorRateDayAlertCooldownMinutes,
	parseFleetPackageErrorRateAlertCooldownState,
	shouldSuppressFleetPackageErrorRateAlert,
	type FleetPackageErrorRateAlertCooldownState,
} from './fleet-package-error-rate-alerts.ts'

const baseAlert: FleetPackageErrorRateAlertCooldownState = {
	version: 1,
	alertedAtMs: Date.parse('2026-10-19T19:00:00.000Z'),
	windowKind: 'day',
	windowEnd: '2026-10-19T19:00:00.000Z',
	topOwnerUsername: 'eluce2',
	eventId: 'day:2026-10-19T19:00:00.000Z',
}

test('day window uses 24h cooldown; same window+top owner never re-pages', () => {
	expect(fleetPackageErrorRateDayAlertCooldownMinutes).toBe(24 * 60)

	expect(
		shouldSuppressFleetPackageErrorRateAlert({
			now: new Date('2026-10-20T18:00:00.000Z'),
			lastAlert: baseAlert,
			windowKind: 'day',
			windowEnd: '2026-10-20T18:00:00.000Z',
			topOwnerUsername: 'eluce2',
		}),
	).toBe(true)

	expect(
		shouldSuppressFleetPackageErrorRateAlert({
			now: new Date('2026-10-20T19:30:00.000Z'),
			lastAlert: baseAlert,
			windowKind: 'day',
			windowEnd: '2026-10-20T19:00:00.000Z',
			topOwnerUsername: 'other',
		}),
	).toBe(false)

	expect(
		shouldSuppressFleetPackageErrorRateAlert({
			now: new Date('2026-10-19T20:00:00.000Z'),
			lastAlert: baseAlert,
			windowKind: 'day',
			windowEnd: '2026-10-19T19:00:00.000Z',
			topOwnerUsername: 'eluce2',
		}),
	).toBe(true)
})

test('hour window keeps six-hour cooldown and same-window identity', () => {
	const hourAlert: FleetPackageErrorRateAlertCooldownState = {
		...baseAlert,
		windowKind: 'hour',
		windowEnd: '2026-10-19T19:00:00.000Z',
		eventId: 'hour:2026-10-19T19:00:00.000Z',
	}

	expect(
		shouldSuppressFleetPackageErrorRateAlert({
			now: new Date('2026-10-19T22:00:00.000Z'),
			lastAlert: hourAlert,
			windowKind: 'hour',
			windowEnd: '2026-10-19T22:00:00.000Z',
			topOwnerUsername: 'eluce2',
		}),
	).toBe(true)

	expect(
		shouldSuppressFleetPackageErrorRateAlert({
			now: new Date('2026-10-20T02:00:00.000Z'),
			lastAlert: hourAlert,
			windowKind: 'hour',
			windowEnd: '2026-10-20T02:00:00.000Z',
			topOwnerUsername: 'other',
		}),
	).toBe(false)

	expect(
		shouldSuppressFleetPackageErrorRateAlert({
			now: new Date('2026-10-20T10:00:00.000Z'),
			lastAlert: hourAlert,
			windowKind: 'hour',
			windowEnd: '2026-10-19T19:00:00.000Z',
			topOwnerUsername: 'eluce2',
		}),
	).toBe(true)
})

test('parseFleetPackageErrorRateAlertCooldownState accepts legacy timestamp strings', () => {
	const legacy = parseFleetPackageErrorRateAlertCooldownState(
		String(Date.parse('2026-10-19T19:00:00.000Z')),
	)
	expect(legacy).toMatchObject({
		version: 1,
		windowKind: 'hour',
		windowEnd: '',
		topOwnerUsername: null,
	})
	expect(
		parseFleetPackageErrorRateAlertCooldownState({
			version: 1,
			alertedAtMs: 1,
			windowKind: 'day',
			windowEnd: 'end',
			topOwnerUsername: 'ada',
			eventId: 'day:end',
		}),
	).toMatchObject({ windowKind: 'day', topOwnerUsername: 'ada' })
})
