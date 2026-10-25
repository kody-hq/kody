import {
	packageJobScheduleAcceptFixtures,
	packageJobScheduleRejectFixtures,
} from '@kody-internal/shared/jobs/package-job-schedule-fixtures.ts'
import { parsePackageJobSchedule } from '@kody-internal/shared/jobs/package-job-schedule.ts'
import { expect, test } from 'vitest'
import { packageJobScheduleSchema } from './types.ts'

/**
 * Guard against the worker Zod wrapper drifting from the shared parser (the
 * same function the CLI uses). Accept and reject every fixture both ways.
 */
test.each(packageJobScheduleAcceptFixtures)(
	'packageJobScheduleSchema agrees with shared parser on accept: $name',
	(fixture) => {
		const shared = parsePackageJobSchedule(fixture.input)
		const zod = packageJobScheduleSchema.safeParse(fixture.input)
		expect(shared.ok).toBe(true)
		expect(zod.success).toBe(true)
		if (!shared.ok || !zod.success) return
		expect(zod.data).toEqual(shared.schedule)
		expect(zod.data).toEqual(fixture.expected)
	},
)

test.each(packageJobScheduleRejectFixtures)(
	'packageJobScheduleSchema agrees with shared parser on reject: $name',
	(fixture) => {
		const shared = parsePackageJobSchedule(fixture.input)
		const zod = packageJobScheduleSchema.safeParse(fixture.input)
		expect(shared.ok).toBe(false)
		expect(zod.success).toBe(false)
		if (shared.ok || zod.success) return
		expect(
			zod.error.issues.some((issue) =>
				issue.message.includes(fixture.messageIncludes),
			),
		).toBe(true)
	},
)
