import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import { recordUsage, type UsageEnv } from '#worker/usage/record-usage.ts'
import { type DynamicWorkerDaySurface } from './dynamic-worker-day-surface.ts'

export type DynamicWorkerDayEnv = UsageEnv & UserMeterEnv

/**
 * Record one `dynamic_worker_day` when this user first uses `workerId` on
 * the current UTC day. Cloudflare bills unique Dynamic Worker ids per UTC
 * day, so repeats of the same id must not increment the usage metric.
 *
 * `surface` tags the LOADER mint that claimed the day (execute, job,
 * package_export, …). Uniqueness is still `(user, workerId, day)` — the
 * first claim's surface is the one stored.
 *
 * Never throws. Missing `USER_METER` skips the write so local/tests without
 * the binding cannot overcount unique days. Returns the claim result so
 * callers can record a `dynamic_worker_invoke` hit or miss; `undefined`
 * when the claim did not run.
 */
export async function recordUniqueDynamicWorkerDay(input: {
	env: DynamicWorkerDayEnv
	userId: OwnerId | null | undefined
	workerId: string
	surface: DynamicWorkerDaySurface
	/**
	 * Saved package id when this claim belongs to a known package run.
	 * Omit for ad hoc execute; never guess.
	 */
	packageId?: string | null
	/** Present for package-app claims; empty string means anonymous. */
	packageAppVisitorUserId?: string
	/** From `usageConnectionKey`; attributes the first claim to a credential. */
	connectionKey?: string | null
	now?: Date
}): Promise<{ created: boolean } | undefined> {
	try {
		if (!input.userId) return
		if (!userMeterNamespace(input.env)) return
		const now = input.now ?? new Date()
		const claimed = await userMeterRpc({
			env: input.env,
			userId: input.userId,
		}).claimDynamicWorkerDay({
			workerId: input.workerId,
			day: utcDayKey(now),
			createdAt: now.toISOString(),
		})
		if (claimed.created) {
			await recordUsage(input.env, {
				userId: input.userId,
				eventType: 'dynamic_worker_day',
				entityId: input.workerId,
				outcome: 'success',
				timestamp: now.toISOString(),
				surface: input.surface,
				...(input.packageId?.trim()
					? { packageId: input.packageId.trim() }
					: {}),
				...(input.packageAppVisitorUserId !== undefined
					? { packageAppVisitorUserId: input.packageAppVisitorUserId }
					: {}),
				...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
			})
		}
		return claimed
	} catch (error) {
		console.warn('dynamic-worker-day-record-failed', error)
	}
}
