import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	isJobIntervalFloorError,
	JobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { getCachedUserEntitlement } from '#worker/entitlements/service.ts'
import type { AuthoredPackageJson } from '#worker/package-registry/types.ts'
import {
	resolvePlanLimits,
	type CreditWalletState,
	type EntitlementLadder,
	type PlanName,
} from '#universal/plans.ts'
import { jobsData } from './jobs-data.ts'
import {
	estimateScheduleMinIntervalMs,
	normalizeJobSchedule,
	normalizeJobTimezone,
} from './schedule.ts'
import type { JobSchedule } from './types.ts'

type PackageManifestJobs = NonNullable<AuthoredPackageJson['kody']['jobs']>

/** An unchanged package job keeps its schedule even under a newer floor. */
export function packageJobNeedsIntervalFloor(input: {
	existingSchedule?: JobSchedule
	existingTimezone?: string | null
	schedule: JobSchedule
	timezone?: string | null
}) {
	if (input.existingSchedule === undefined) return true
	return (
		JSON.stringify(input.existingSchedule) !== JSON.stringify(input.schedule) ||
		input.existingTimezone !== input.timezone
	)
}

export function assertJobScheduleIntervalFloor(input: {
	plan: PlanName
	ladder?: EntitlementLadder
	creditWallet?: CreditWalletState
	schedule: JobSchedule
	timezone?: string | null
}) {
	const minIntervalMs = resolvePlanLimits(
		input.plan,
		input.ladder ?? 'public',
		input.creditWallet ?? 'none',
	).minJobIntervalMs
	if (minIntervalMs <= 0) return
	const intervalMs = estimateScheduleMinIntervalMs({
		schedule: input.schedule,
		timezone: input.timezone,
	})
	if (intervalMs == null || intervalMs >= minIntervalMs) return
	throw new JobIntervalFloorError({
		plan: input.plan,
		minIntervalMs,
	})
}

/**
 * The schedule refusal publishing these manifest jobs would hit in
 * `syncPackageJobsForPackage` (an unreadable schedule, or the plan interval
 * floor), found without writing anything. Like publish, only new or
 * rescheduled jobs are held to the floor.
 */
export async function findPackageJobIntervalFloorViolation(input: {
	env: Env
	userId: OwnerId
	email: string | null
	sourceId?: string
	jobs: PackageManifestJobs
}): Promise<string | null> {
	const entries = Object.entries(input.jobs)
	if (entries.length === 0) return null
	const entitlement = await getCachedUserEntitlement(input.env.APP_DB, {
		userId: input.userId,
		email: input.email,
	})
	const violations: Array<{
		jobName: string
		schedule: JobSchedule
		timezone: string
		message: string
	}> = []
	for (const [jobName, definition] of entries) {
		let schedule: JobSchedule
		let timezone: string
		try {
			schedule = normalizeJobSchedule(definition.schedule)
			timezone = normalizeJobTimezone(definition.timezone)
			assertJobScheduleIntervalFloor({
				plan: entitlement.plan,
				ladder: entitlement.ladder,
				creditWallet: entitlement.creditWallet,
				schedule,
				timezone,
			})
		} catch (error) {
			// Job sync on publish refuses a schedule it cannot read, too.
			if (!isJobIntervalFloorError(error)) {
				return `kody.jobs.${jobName}.schedule: ${error instanceof Error ? error.message : String(error)}`
			}
			violations.push({
				jobName,
				schedule: normalizeJobSchedule(definition.schedule),
				timezone: normalizeJobTimezone(definition.timezone),
				message: error.message,
			})
		}
	}
	if (violations.length === 0) return null
	const existing = input.sourceId
		? new Map(
				(await jobsData(input.env).listJobsForUser({ userId: input.userId }))
					.filter((row) => row.source_id === input.sourceId)
					.map((row) => [row.name, row.record] as const),
			)
		: new Map()
	const violation = violations.find((entry) =>
		packageJobNeedsIntervalFloor({
			existingSchedule: existing.get(entry.jobName)?.schedule,
			existingTimezone: existing.get(entry.jobName)?.timezone,
			schedule: entry.schedule,
			timezone: entry.timezone,
		}),
	)
	return violation
		? `kody.jobs.${violation.jobName}.schedule: ${violation.message}`
		: null
}
