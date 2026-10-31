/**
 * Every schedule shape production accepts for `kody.jobs.*.schedule`, plus
 * representative rejects. Used by worker and CLI parity tests.
 */

import {
	invalidPackageJobScheduleMessage,
	removedOnceJobScheduleMessage,
	type PackageJobSchedule,
} from './package-job-schedule.ts'

export type PackageJobScheduleAcceptFixture = {
	name: string
	input: unknown
	expected: PackageJobSchedule
}

export type PackageJobScheduleRejectFixture = {
	name: string
	input: unknown
	/** Substring that must appear in the shared parser error message. */
	messageIncludes: string
}

/** Schedules production publish accepts today (cron + interval). */
export const packageJobScheduleAcceptFixtures: Array<PackageJobScheduleAcceptFixture> =
	[
		{
			name: 'cron daily',
			input: { type: 'cron', expression: '0 9 * * *' },
			expected: { type: 'cron', expression: '0 9 * * *' },
		},
		{
			name: 'cron hourly',
			input: { type: 'cron', expression: '0 * * * *' },
			expected: { type: 'cron', expression: '0 * * * *' },
		},
		{
			name: 'cron with extra keys stripped',
			input: {
				type: 'cron',
				expression: '30 6 * * 1-5',
				timezone: 'ignored-here',
			},
			expected: { type: 'cron', expression: '30 6 * * 1-5' },
		},
		{
			name: 'interval 15m',
			input: { type: 'interval', every: '15m' },
			expected: { type: 'interval', every: '15m' },
		},
		{
			name: 'interval 1h',
			input: { type: 'interval', every: '1h' },
			expected: { type: 'interval', every: '1h' },
		},
		{
			name: 'interval 1d',
			input: { type: 'interval', every: '1d' },
			expected: { type: 'interval', every: '1d' },
		},
		{
			name: 'interval 1m',
			input: { type: 'interval', every: '1m' },
			expected: { type: 'interval', every: '1m' },
		},
		{
			name: 'interval 30s',
			input: { type: 'interval', every: '30s' },
			expected: { type: 'interval', every: '30s' },
		},
		{
			name: 'interval 100ms',
			input: { type: 'interval', every: '100ms' },
			expected: { type: 'interval', every: '100ms' },
		},
		{
			name: 'interval with extra keys stripped',
			input: { type: 'interval', every: '2h', label: 'extra' },
			expected: { type: 'interval', every: '2h' },
		},
	]

/** Inputs production publish rejects. */
export const packageJobScheduleRejectFixtures: Array<PackageJobScheduleRejectFixture> =
	[
		{
			name: 'retired once',
			input: { type: 'once', runAt: '2027-01-01T16:00:00Z' },
			messageIncludes: removedOnceJobScheduleMessage,
		},
		{
			name: 'bare cron string',
			input: '0 * * * *',
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'null',
			input: null,
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'undefined',
			input: undefined,
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'number',
			input: 15,
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'array',
			input: ['interval', '15m'],
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'cron missing expression',
			input: { type: 'cron' },
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'cron empty expression',
			input: { type: 'cron', expression: '' },
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'interval missing every',
			input: { type: 'interval' },
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'interval empty every',
			input: { type: 'interval', every: '' },
			messageIncludes: invalidPackageJobScheduleMessage,
		},
		{
			name: 'unknown type',
			input: { type: 'weekly', expression: '0 9 * * 1' },
			messageIncludes: invalidPackageJobScheduleMessage,
		},
	]
