import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	computeNextRunAt,
	computeNextRunAtAfterOccurrence,
	estimateScheduleMinIntervalMs,
	isJobDue,
	isJobExpired,
	normalizeJobExpiresAt,
	normalizeJobSchedule,
} from './schedule.ts'
import { type JobRecord } from './types.ts'

test('job schedule helpers normalize schedules and compute the next run time', () => {
	expect(
		normalizeJobSchedule({
			type: 'cron',
			expression: '  */15   7 * * 1-5  ',
		}),
	).toEqual({
		type: 'cron',
		expression: '*/15 7 * * 1-5',
	})
	expect(
		normalizeJobSchedule({
			type: 'interval',
			every: ' 05M ',
		}),
	).toEqual({
		type: 'interval',
		every: '5m',
	})

	expect(
		computeNextRunAt({
			schedule: {
				type: 'cron',
				expression: '0 7 * * *',
			},
			timezone: 'America/New_York',
			from: '2026-03-08T10:30:00.000Z',
		}),
	).toBe('2026-03-08T11:00:00.000Z')
	expect(
		computeNextRunAt({
			schedule: {
				type: 'interval',
				every: '15m',
			},
			from: '2026-04-17T15:00:00.000Z',
		}),
	).toBe('2026-04-17T15:15:00.000Z')

	// Late settle must not skip intermediate hourly firings.
	expect(
		computeNextRunAtAfterOccurrence({
			schedule: { type: 'cron', expression: '0 * * * *' },
			timezone: 'UTC',
			scheduledFor: '2026-04-17T10:00:00.000Z',
		}),
	).toBe('2026-04-17T11:00:00.000Z')
	expect(
		computeNextRunAt({
			schedule: { type: 'cron', expression: '0 * * * *' },
			timezone: 'UTC',
			from: '2026-04-17T15:03:00.000Z',
		}),
	).toBe('2026-04-17T16:00:00.000Z')
})

test('estimateScheduleMinIntervalMs measures interval and cron gaps', () => {
	expect(
		estimateScheduleMinIntervalMs({
			schedule: { type: 'interval', every: '5m' },
		}),
	).toBe(5 * 60 * 1000)
	expect(
		estimateScheduleMinIntervalMs({
			schedule: { type: 'cron', expression: '*/5 * * * *' },
			timezone: 'UTC',
			from: '2026-04-17T15:00:00.000Z',
		}),
	).toBe(5 * 60 * 1000)
	expect(
		estimateScheduleMinIntervalMs({
			schedule: { type: 'cron', expression: '0 * * * *' },
			timezone: 'UTC',
			from: '2026-04-17T15:00:00.000Z',
		}),
	).toBe(60 * 60 * 1000)
})

test('expires_at helpers treat UTC expiry as a schedule gate separate from enabled', () => {
	expect(normalizeJobExpiresAt(null)).toBeNull()
	expect(normalizeJobExpiresAt(undefined)).toBeNull()
	expect(normalizeJobExpiresAt('2026-04-20T18:30:00Z')).toBe(
		'2026-04-20T18:30:00.000Z',
	)
	expect(() => normalizeJobExpiresAt('2026-04-20T18:30:00')).toThrow(
		/UTC timestamp/,
	)
	expect(() => normalizeJobExpiresAt('2026-02-30T00:00:00Z')).toThrow(
		/calendar date/,
	)

	const now = new Date('2026-04-20T18:30:00.000Z')
	const base: JobRecord = {
		version: 1,
		id: 'job-1',
		userId: ownerIdFromStored('user-1'),
		name: 'Expiring job',
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'job:job-1',
		schedule: { type: 'interval', every: '15m' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: '2026-04-20T18:30:00.000Z',
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
		nextRunAt: '2026-04-20T18:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	expect(isJobExpired(base, now)).toBe(true)
	expect(isJobDue(base, now)).toBe(false)
	expect(
		isJobDue({ ...base, expiresAt: '2026-04-20T19:00:00.000Z' }, now),
	).toBe(true)
	expect(isJobDue({ ...base, expiresAt: null }, now)).toBe(true)
})
