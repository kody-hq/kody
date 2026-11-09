import { waitUntil } from 'cloudflare:workers'
import { dispatchUserLifecycleSubscriptionEvent } from './user-lifecycle-package-subscriptions.ts'
import {
	buildUserCreatedEvent,
	buildUserDeletedEvent,
	buildUserGuestClaimedEvent,
	type UserCreatedGuest,
	type UserCreatedSource,
	type UserLifecycleIdentity,
} from './user-lifecycle-subscription-event.ts'
import type { FirstTouchAttribution } from '#universal/first-touch-attribution.ts'

type UserLifecycleScheduleEnv = Pick<
	Env,
	'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
>

type UserLifecycleEventInput = Parameters<
	typeof dispatchUserLifecycleSubscriptionEvent
>[0]['event']

function warnDispatchFailed(event: UserLifecycleEventInput, error: unknown) {
	console.warn('user-lifecycle-subscription-dispatch-failed', {
		event: event.event,
		userId: event.user.id,
		error,
	})
}

/** Never throws and never blocks the caller: the account change already committed. */
function scheduleUserLifecycleSubscriptionEvent(input: {
	env: UserLifecycleScheduleEnv
	event: UserLifecycleEventInput
}) {
	try {
		waitUntil(
			Promise.resolve()
				.then(() =>
					dispatchUserLifecycleSubscriptionEvent({
						env: input.env,
						event: input.event,
					}),
				)
				.catch((error: unknown) => warnDispatchFailed(input.event, error)),
		)
	} catch (error) {
		warnDispatchFailed(input.event, error)
	}
}

export function scheduleUserCreatedEvent(input: {
	env: UserLifecycleScheduleEnv
	user: UserLifecycleIdentity
	source: UserCreatedSource
	createdAt?: string
	attribution?: FirstTouchAttribution | null
	guest?: UserCreatedGuest
}) {
	scheduleUserLifecycleSubscriptionEvent({
		env: input.env,
		event: buildUserCreatedEvent({
			user: input.user,
			source: input.source,
			createdAt: input.createdAt ?? new Date().toISOString(),
			attribution: input.attribution,
			guest: input.guest,
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

export function scheduleGuestClaimedEvent(
	input: {
		env: UserLifecycleScheduleEnv
	} & Parameters<typeof buildUserGuestClaimedEvent>[0],
) {
	const { env, ...event } = input
	try {
		scheduleUserLifecycleSubscriptionEvent({
			env,
			event: buildUserGuestClaimedEvent(event),
		})
	} catch (error) {
		console.warn('user-lifecycle-subscription-dispatch-failed', {
			event: 'user.guest_claimed',
			userId: event.user.id,
			error,
		})
	}
}
