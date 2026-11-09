import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	AccountDeletionInProgressError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { stripePlanRefreshDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'

export const stripePlanRefreshBackstopDelayMs = 60 * 60 * 1000

/**
 * Stripe plan refresh already keys its alarm on the trimmed owner id.
 * An `OwnerId` from `request.org.id` is already trimmed, so this is a
 * no-op there. A stored id with surrounding spaces keeps the trimmed name
 * this client has always used. The name builder itself does not trim.
 */
function stripePlanRefreshOwnerId(ownerId: OwnerId): OwnerId | null {
	const trimmed = ownerId.trim()
	if (!trimmed) return null
	return trimmed === ownerId ? ownerId : (trimmed as OwnerId)
}

export async function scheduleStripePlanRefreshBackstop(input: {
	env: Env
	/** Personal org id (= owner stable user id) or team org id. */
	userId: OwnerId
	now?: Date
}) {
	const userId = stripePlanRefreshOwnerId(input.userId)
	if (!userId) return false
	try {
		const activityAt = input.now?.getTime() ?? Date.now()
		const refreshAt =
			Math.max(activityAt, Date.now()) + stripePlanRefreshBackstopDelayMs
		const id = input.env.STRIPE_PLAN_REFRESH.idFromName(
			stripePlanRefreshDurableObjectName(userId),
		)
		const stub = input.env.STRIPE_PLAN_REFRESH.get(id)
		const schedule = async () => {
			await stub.schedule({
				userId,
				refreshAt,
			})
		}
		const livePersonalUser = await input.env.APP_DB.prepare(
			`SELECT 1 AS ok FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(userId)
			.first<{ ok: number }>()
		if (livePersonalUser) {
			await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: userId,
				holder: 'stripe_plan_refresh_schedule',
				env: input.env,
				write: schedule,
			})
			return true
		}
		// Soft-deleted personal accounts have no live users row and must not
		// re-arm alarms. Only a live team org (no personal identity) schedules
		// without the account write lease.
		const liveTeamOrg = await input.env.APP_DB.prepare(
			`SELECT 1 AS ok FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(userId)
			.first<{ ok: number }>()
		if (!liveTeamOrg) return false
		await schedule()
		return true
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) return false
		console.error('stripe_plan_refresh_schedule_failed', { userId, error })
		return false
	}
}

export async function purgeStripePlanRefreshForUser(input: {
	env: Env
	userId: OwnerId
}) {
	const namespace = (input.env as Partial<Env>).STRIPE_PLAN_REFRESH
	if (!namespace) return { purged: false }
	const userId = stripePlanRefreshOwnerId(input.userId)
	if (!userId) return { purged: false }
	const id = namespace.idFromName(stripePlanRefreshDurableObjectName(userId))
	await namespace.get(id).purgeUser({ userId })
	return { purged: true }
}
