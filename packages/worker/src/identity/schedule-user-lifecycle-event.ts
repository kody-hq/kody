import { waitUntil } from 'cloudflare:workers'
import { dispatchUserLifecycleSubscriptionEvent } from './user-lifecycle-package-subscriptions.ts'
import {
	buildUserCreatedEvent,
	buildUserDeletedEvent,
	type UserCreatedSource,
	type UserLifecycleIdentity,
} from './user-lifecycle-subscription-event.ts'
import { type FirstTouchAttribution } from '#universal/first-touch-attribution.ts'

type UserLifecycleScheduleEnv = Pick<
	Env,
	'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
>

function scheduleUserLifecycleSubscriptionEvent(input: {
	env: UserLifecycleScheduleEnv
	event: Parameters<typeof dispatchUserLifecycleSubscriptionEvent>[0]['event']
}) {
	waitUntil(
		dispatchUserLifecycleSubscriptionEvent({
			env: input.env,
			event: input.event,
		}).catch((error) => {
			console.warn('user-lifecycle-subscription-dispatch-failed', {
				event: input.event.event,
				userId: input.event.user.id,
				error,
			})
		}),
	)
}

export function scheduleUserCreatedEvent(input: {
	env: UserLifecycleScheduleEnv
	user: UserLifecycleIdentity
	source: UserCreatedSource
	createdAt?: string
	attribution?: FirstTouchAttribution | null
}) {
	scheduleUserLifecycleSubscriptionEvent({
		env: input.env,
		event: buildUserCreatedEvent({
			user: input.user,
			source: input.source,
			createdAt: input.createdAt ?? new Date().toISOString(),
			attribution: input.attribution,
		}),
	})
}

export function scheduleUserDeletedEvent(input: {
	env: UserLifecycleScheduleEnv
	user: UserLifecycleIdentity
	/** The account's `users.created_at`, read before the row is removed. */
	createdAt: string
	deletedAt?: string
}) {
	scheduleUserLifecycleSubscriptionEvent({
		env: input.env,
		event: buildUserDeletedEvent({
			user: input.user,
			createdAt: input.createdAt,
			deletedAt: input.deletedAt ?? new Date().toISOString(),
		}),
	})
}
