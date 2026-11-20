import { Data } from 'effect'

const causeMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause)

/** A D1 call failed. `cause` is the driver error, kept for Sentry. */
export class DatabaseError extends Data.TaggedError('DatabaseError')<{
	readonly operation: string
	readonly cause: unknown
}> {
	override get message() {
		return `Newsletter database ${this.operation} failed: ${causeMessage(this.cause)}`
	}
}

export class InvalidEmail extends Data.TaggedError('InvalidEmail') {}

export class IpRateLimited extends Data.TaggedError('IpRateLimited') {}

export class VerificationFailed extends Data.TaggedError('VerificationFailed')<{
	readonly reason: 'rejected' | 'timeout'
}> {}

/** Turnstile keys are missing on a deployment that requires them. */
export class VerificationUnavailable extends Data.TaggedError(
	'VerificationUnavailable',
) {}

export class EmailUnconfigured extends Data.TaggedError('EmailUnconfigured')<{
	readonly email: string
}> {}

export class ConfirmationSendFailed extends Data.TaggedError(
	'ConfirmationSendFailed',
)<{ readonly cause: unknown }> {}

export class InvalidLink extends Data.TaggedError('InvalidLink') {}

export class QueueSendFailed extends Data.TaggedError('QueueSendFailed')<{
	readonly outboxId: string
	readonly cause: unknown
}> {}

export class SubscriberDispatchFailed extends Data.TaggedError(
	'SubscriberDispatchFailed',
)<{ readonly cause: unknown }> {
	override get message() {
		return `Consent dispatch failed: ${causeMessage(this.cause)}`
	}
}

/** Some admin package subscribers did not handle the event; retry later. */
export class SubscribersRejected extends Data.TaggedError(
	'SubscribersRejected',
)<{ readonly failed: number; readonly total: number }> {
	override get message() {
		return `whats_new.consent.changed was not handled by ${this.failed} of ${this.total} subscribers.`
	}
}
