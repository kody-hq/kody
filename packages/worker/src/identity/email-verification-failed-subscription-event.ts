import {
	isEmailVerificationDeliveryClass,
	type EmailVerificationDeliveryClass,
	type EmailVerificationDeliveryStatus,
} from '#universal/email-verification-delivery.ts'
import type { UserLifecycleIdentity } from './user-lifecycle-subscription-event.ts'

export const userEmailVerificationFailedTopic = 'user.email_verification.failed'

export const userEmailVerificationFailedEventTopics = [
	userEmailVerificationFailedTopic,
] as const

export type UserEmailVerificationFailedTopic =
	typeof userEmailVerificationFailedTopic

const terminalFailureStatuses = [
	'bounced',
	'failed',
	'rejected',
	'complained',
] as const satisfies ReadonlyArray<EmailVerificationDeliveryStatus>

export type UserEmailVerificationFailedStatus =
	(typeof terminalFailureStatuses)[number]

export type UserEmailVerificationFailedEvent = {
	event: UserEmailVerificationFailedTopic
	user: UserLifecycleIdentity
	status: UserEmailVerificationFailedStatus
	class: EmailVerificationDeliveryClass | null
	admin_user_url: string
	occurred_at: string
}

export function isUserEmailVerificationFailedEventTopic(
	value: string,
): value is UserEmailVerificationFailedTopic {
	return (
		userEmailVerificationFailedEventTopics as ReadonlyArray<string>
	).includes(value)
}

export function isUserEmailVerificationFailedStatus(
	value: string,
): value is UserEmailVerificationFailedStatus {
	return (terminalFailureStatuses as ReadonlyArray<string>).includes(value)
}

export function buildUserEmailVerificationFailedEvent(input: {
	user: UserLifecycleIdentity
	status: UserEmailVerificationFailedStatus
	class?: string | null
	adminUserUrl: string
	occurredAt: string
}): UserEmailVerificationFailedEvent {
	return {
		event: userEmailVerificationFailedTopic,
		user: input.user,
		status: input.status,
		class: isEmailVerificationDeliveryClass(input.class) ? input.class : null,
		admin_user_url: input.adminUserUrl,
		occurred_at: input.occurredAt,
	}
}

export function buildUserEmailVerificationFailedIdempotencyKey(input: {
	event: UserEmailVerificationFailedEvent
	packageId: string
}) {
	return `user-email-verification:${input.event.event}:${input.event.user.id}:${input.event.occurred_at}:${input.packageId}`
}
