import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	AccountDeletionInProgressError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { stripePlanRefreshBackstopDelayMs } from './stripe-plan-refresh-client.ts'
import {
	refreshStripePlanForOrg,
	refreshStripePlanForUser,
} from './subscription-sync.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const userIdStorageKey = 'user-id'

class StripePlanRefreshBase extends DurableObject<Env> {
	async schedule(input: { userId: OwnerId; refreshAt?: number }) {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Stripe plan refresh requires a non-empty userId.')
		}
		const refreshAt =
			input.refreshAt ?? Date.now() + stripePlanRefreshBackstopDelayMs
		if (!Number.isFinite(refreshAt)) {
			throw new Error('Stripe plan refresh requires a finite refreshAt.')
		}
		await this.ctx.storage.put(userIdStorageKey, userId)
		await this.ctx.storage.setAlarm(refreshAt)
		return { scheduledAt: new Date(refreshAt).toISOString() }
	}

	async purgeUser(input: { userId: OwnerId }) {
		const storedUserId = await this.ctx.storage.get<string>(userIdStorageKey)
		if (storedUserId && storedUserId !== input.userId.trim()) {
			throw new Error('Stripe plan refresh userId does not match stored owner.')
		}
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		return { ok: true as const }
	}

	async alarm() {
		const billingSubjectId =
			await this.ctx.storage.get<OwnerId>(userIdStorageKey)
		if (!billingSubjectId) {
			await this.ctx.storage.deleteAll()
			return
		}
		const user = await this.env.APP_DB.prepare(
			`SELECT id
			 FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(billingSubjectId)
			.first<{ id: number }>()
		const org = await this.env.APP_DB.prepare(
			`SELECT stripe_customer_id FROM orgs
			 WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(billingSubjectId)
			.first<{ stripe_customer_id: string | null }>()
		const customerId = org?.stripe_customer_id?.trim() || null
		if (!customerId) {
			await this.ctx.storage.deleteAll()
			return
		}

		try {
			if (user?.id != null) {
				await withAccountWriteLease({
					db: this.env.APP_DB,
					stableUserId: billingSubjectId,
					holder: 'stripe_plan_refresh_alarm',
					env: this.env,
					write: async () => {
						await refreshStripePlanForUser({
							env: this.env,
							userId: user.id,
							customerId,
						})
					},
				})
			} else {
				await refreshStripePlanForOrg({
					env: this.env,
					orgId: billingSubjectId,
					customerId,
				})
			}
		} catch (error) {
			if (error instanceof AccountDeletionInProgressError) {
				await this.ctx.storage.deleteAll()
				return
			}
			console.error('stripe_plan_refresh_alarm_failed', {
				userId: billingSubjectId,
				error,
			})
			Sentry.withScope((scope) => {
				scope.setTag('billing.operation', 'stripe_plan_refresh_alarm')
				scope.setContext('stripe_plan_refresh', { userId: billingSubjectId })
				Sentry.captureException(error)
			})
			await this.ctx.storage.setAlarm(
				Date.now() + stripePlanRefreshBackstopDelayMs,
			)
			return
		}
		console.info('stripe_plan_refresh_alarm', {
			userId: billingSubjectId,
			status: 'refreshed',
		})
		await this.ctx.storage.deleteAll()
	}
}

export const StripePlanRefresh = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	StripePlanRefreshBase,
)
