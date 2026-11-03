import type { UserLifecycleIdentity } from './user-lifecycle-subscription-event.ts'

export const userEmailVerificationStalledTopic =
	'user.email_verification.stalled'

export const userEmailVerificationStalledEventTopics = [
	userEmailVerificationStalledTopic,
] as const

export type UserEmailVerificationStalledTopic =
	typeof userEmailVerificationStalledTopic

export type UserEmailVerificationStalledEvent = {
	event: UserEmailVerificationStalledTopic
	user: UserLifecycleIdentity
	status: 'accepted'
	accepted_at: string
	stall_after_minutes: number
	admin_user_url: string
	occurred_at: string
}

export function isUserEmailVerificationStalledEventTopic(
	value: string,
): value is UserEmailVerificationStalledTopic {
	return (
		userEmailVerificationStalledEventTopics as ReadonlyArray<string>
	).includes(value)
}

export function buildUserEmailVerificationStalledEvent(input: {
	user: UserLifecycleIdentity
	acceptedAt: string
	stallAfterMinutes: number
	adminUserUrl: string
	occurredAt: string
}): UserEmailVerificationStalledEvent {
	return {
		event: userEmailVerificationStalledTopic,
		user: input.user,
		status: 'accepted',
		accepted_at: input.acceptedAt,
		stall_after_minutes: input.stallAfterMinutes,
		admin_user_url: input.adminUserUrl,
		occurred_at: input.occurredAt,
	}
}

export function buildUserEmailVerificationStalledIdempotencyKey(input: {
	event: UserEmailVerificationStalledEvent
	packageId: string
}) {
	return `user-email-verification:${input.event.event}:${input.event.user.id}:${input.event.accepted_at}:${input.packageId}`
}
