import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { jobsData } from './jobs-data.ts'
import { syncJobManagerAlarm } from './manager-client.ts'
import { computeNextRunAt, isJobExpired } from './schedule.ts'

export type ArmJobForEnablementResult =
	| 'armed'
	| 'already_on'
	| 'expired'
	| 'missing'

/**
 * Turn a package cron job's own `enabled` flag on when a person turns its
 * enablement on, and schedule its next tick from now. A scheduled tick runs
 * only when the job row is enabled AND an enablement is on, so turning the
 * enablement on alone left a disabled job idle with a stale `next_run_at`.
 * `jobUpdate({ enabled: true })` already syncs the other direction (it
 * ensures the owner's enablement). The caller must already hold `job:write`.
 * An expired job stays off.
 */
export async function armJobForEnablement(input: {
	env: Env
	orgId: OwnerId
	jobId: string
	now?: Date
}): Promise<ArmJobForEnablementResult> {
	const result = await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.orgId,
		env: input.env,
		async write(): Promise<ArmJobForEnablementResult> {
			const row = await jobsData(input.env).getJobById({
				userId: input.orgId,
				jobId: input.jobId,
			})
			if (!row) return 'missing'
			const existing = row.record
			if (existing.enabled) return 'already_on'
			const now = input.now ?? new Date()
			if (isJobExpired(existing, now)) return 'expired'
			const didUpdate = await jobsData(input.env).updateJob({
				userId: input.orgId,
				job: {
					...existing,
					enabled: true,
					updatedAt: now.toISOString(),
					nextRunAt: computeNextRunAt({
						schedule: existing.schedule,
						timezone: existing.timezone,
						from: now,
					}),
				},
				callerContextJson: row.callerContextJson,
			})
			if (!didUpdate) {
				throw new Error(`Job "${existing.id}" could not be turned on.`)
			}
			return 'armed'
		},
	})
	// Also on `already_on`: a retry after a failed sync restores the alarm.
	if (result === 'armed' || result === 'already_on') {
		await syncJobManagerAlarm({ env: input.env, userId: input.orgId })
	}
	return result
}
