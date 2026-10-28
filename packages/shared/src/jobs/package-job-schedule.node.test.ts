import { expect, test } from 'vitest'
import {
	packageJobScheduleAcceptFixtures,
	packageJobScheduleRejectFixtures,
} from './package-job-schedule-fixtures.ts'
import {
	formatPackageJobScheduleSummary,
	parsePackageJobSchedule,
} from './package-job-schedule.ts'

test.each(packageJobScheduleAcceptFixtures)(
	'parsePackageJobSchedule accepts $name',
	(fixture) => {
		expect(parsePackageJobSchedule(fixture.input)).toEqual({
			ok: true,
			schedule: fixture.expected,
		})
	},
)

test.each(packageJobScheduleRejectFixtures)(
	'parsePackageJobSchedule rejects $name',
	(fixture) => {
		const parsed = parsePackageJobSchedule(fixture.input)
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return
		expect(parsed.message).toContain(fixture.messageIncludes)
	},
)

test('formatPackageJobScheduleSummary covers cron and interval', () => {
	expect(
		formatPackageJobScheduleSummary({
			type: 'cron',
			expression: '0 9 * * *',
		}),
	).toBe('0 9 * * *')
	expect(
		formatPackageJobScheduleSummary({ type: 'interval', every: '15m' }),
	).toBe('every 15m')
})
