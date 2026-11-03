import type { UserLifecycleIdentity } from '#worker/identity/user-lifecycle-subscription-event.ts'
import type { EmailDeliveryStatus } from './types.ts'

export const userEmailOutboundPausedTopic = 'user.email_outbound.paused'

export const userEmailOutboundPausedEventTopics = [
	userEmailOutboundPausedTopic,
] as const

export type UserEmailOutboundPausedTopic = typeof userEmailOutboundPausedTopic

export type UserEmailOutboundPausedReason = Extract<
	EmailDeliveryStatus,
	'complained' | 'bounced'
>

export type UserEmailOutboundPausedEvent = {
	event: UserEmailOutboundPausedTopic
	user: UserLifecycleIdentity
	reason: UserEmailOutboundPausedReason
	bounce_threshold: number | null
	admin_user_url: string
	occurred_at: string
}

export function isUserEmailOutboundPausedEventTopic(
	value: string,
): value is UserEmailOutboundPausedTopic {
	return (userEmailOutboundPausedEventTopics as ReadonlyArray<string>).includes(
		value,
	)
}

export function isUserEmailOutboundPausedReason(
	value: string,
): value is UserEmailOutboundPausedReason {
	return value === 'complained' || value === 'bounced'
}

export function buildUserEmailOutboundPausedEvent(input: {
	user: UserLifecycleIdentity
	reason: UserEmailOutboundPausedReason
	bounceThreshold?: number | null
	adminUserUrl: string
	occurredAt: string
}): UserEmailOutboundPausedEvent {
	return {
		event: userEmailOutboundPausedTopic,
		user: input.user,
		reason: input.reason,
		bounce_threshold:
			input.reason === 'bounced' ? (input.bounceThreshold ?? null) : null,
		admin_user_url: input.adminUserUrl,
		occurred_at: input.occurredAt,
	}
}

export function buildUserEmailOutboundPausedIdempotencyKey(input: {
	event: UserEmailOutboundPausedEvent
	packageId: string
}) {
	return `user-email-outbound:${input.event.event}:${input.event.user.id}:${input.event.occurred_at}:${input.packageId}`
}
