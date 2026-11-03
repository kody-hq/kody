import { dispatchUserEmailVerificationFailedSubscriptionEvent } from '#worker/identity/email-verification-failed-package-subscriptions.ts'
import {
	buildUserEmailVerificationFailedEvent,
	isUserEmailVerificationFailedStatus,
} from '#worker/identity/email-verification-failed-subscription-event.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import type { RecordedTransactionalDelivery } from './verification-delivery.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

type VerificationNotifyEnv = Pick<
	Env,
	'APP_DB' | 'APP_BASE_URL' | 'BUNDLE_ARTIFACTS_KV'
>

/**
 * Best-effort operator notification when signup/verify mail hits a terminal
 * delivery failure. Fans `user.email_verification.failed` to admin-owned
 * packages. A dispatch failure must never fail delivery-event processing —
 * the user row already carries the bounce.
 */
export async function notifyAdminsOfVerificationDeliveryFailure(input: {
	env: VerificationNotifyEnv
	event: RecordedTransactionalDelivery
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	try {
		if (!isUserEmailVerificationFailedStatus(input.event.status)) return
		const user = await input.env.APP_DB.prepare(
			`SELECT username, email, stable_user_id FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(input.event.userId)
			.first<{
				username: string
				email: string
				stable_user_id: string
			}>()
		const username = user?.username ?? 'unknown'
		const email = user?.email ?? input.event.recipient
		const adminUsersPath = user?.stable_user_id
			? `/admin/users/${user.stable_user_id}`
			: '/admin/users'
		const adminUserUrl = joinAppUrl({
			env: input.env,
			path: adminUsersPath,
		})
		const dispatchPromise =
			dispatchUserEmailVerificationFailedSubscriptionEvent({
				env: input.env,
				event: buildUserEmailVerificationFailedEvent({
					user: {
						id: user?.stable_user_id ?? String(input.event.userId),
						username,
						email,
					},
					status: input.event.status,
					class: input.event.class,
					adminUserUrl,
					occurredAt: new Date().toISOString(),
				}),
				waitUntil: input.waitUntil,
			}).catch((error) => {
				console.warn(
					'email-verification-failed-subscription-dispatch-failed',
					error,
				)
			})
		// Do not await fan-out on the queue path: a hung invoke can time out
		// the consumer after the bounce is already committed, and retries
		// skip this notify once alreadyTerminal is set.
		if (input.waitUntil) {
			input.waitUntil(dispatchPromise)
			return
		}
		await dispatchPromise
	} catch (error) {
		console.warn('email-verification-delivery-notification-failed', error)
	}
}
