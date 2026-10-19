import {
	type PlatformFeedbackAction,
	type PlatformFeedbackStatus,
} from './types.ts'

export class PlatformFeedbackDispatchCancelledError extends Error {
	readonly feedbackId: string

	constructor(feedbackId: string) {
		super(
			`Platform feedback "${feedbackId}" was deleted before notification dispatch.`,
		)
		this.name = 'PlatformFeedbackDispatchCancelledError'
		this.feedbackId = feedbackId
	}
}

export class PlatformFeedbackNotFoundError extends Error {
	constructor(feedbackId: string) {
		super(`Platform feedback "${feedbackId}" was not found.`)
		this.name = 'PlatformFeedbackNotFoundError'
	}
}

export class PlatformFeedbackInvalidTransitionError extends Error {
	constructor(input: {
		feedbackId: string
		status: PlatformFeedbackStatus
		action: PlatformFeedbackAction
	}) {
		super(
			`Cannot ${input.action} platform feedback "${input.feedbackId}" from status "${input.status}". Terminal feedback cannot change to another status.`,
		)
		this.name = 'PlatformFeedbackInvalidTransitionError'
	}
}

export class PlatformFeedbackConcurrentUpdateError extends Error {
	constructor(feedbackId: string) {
		super(
			`Platform feedback "${feedbackId}" changed concurrently. Read it again and retry the requested action.`,
		)
		this.name = 'PlatformFeedbackConcurrentUpdateError'
	}
}

const platformFeedbackUrgentSupportNote =
	'For urgent issues, email support@kody.codes.'

export class PlatformFeedbackSubmissionRateLimitError extends Error {
	constructor(limit: number, retryAfterSeconds: number) {
		super(
			`Platform feedback is limited to ${limit} submissions per rolling 24 hours. Retry after ${retryAfterSeconds} seconds. ${platformFeedbackUrgentSupportNote}`,
		)
		this.name = 'PlatformFeedbackSubmissionRateLimitError'
	}
}

export class PlatformFeedbackActiveQueueLimitError extends Error {
	constructor(limit: number) {
		super(
			`You already have ${limit} open or triaged platform feedback submissions. Wait for an admin to review them before submitting more. ${platformFeedbackUrgentSupportNote}`,
		)
		this.name = 'PlatformFeedbackActiveQueueLimitError'
	}
}

export class PlatformFeedbackSubmissionConflictError extends Error {
	constructor() {
		super(
			`Platform feedback submission limits changed concurrently. Retry the submission. ${platformFeedbackUrgentSupportNote}`,
		)
		this.name = 'PlatformFeedbackSubmissionConflictError'
	}
}

export type PlatformFeedbackDomainError =
	| PlatformFeedbackNotFoundError
	| PlatformFeedbackInvalidTransitionError
	| PlatformFeedbackConcurrentUpdateError
	| PlatformFeedbackSubmissionRateLimitError
	| PlatformFeedbackActiveQueueLimitError
	| PlatformFeedbackSubmissionConflictError

export function isPlatformFeedbackDomainError(
	error: unknown,
): error is PlatformFeedbackDomainError {
	return (
		error instanceof PlatformFeedbackNotFoundError ||
		error instanceof PlatformFeedbackInvalidTransitionError ||
		error instanceof PlatformFeedbackConcurrentUpdateError ||
		error instanceof PlatformFeedbackSubmissionRateLimitError ||
		error instanceof PlatformFeedbackActiveQueueLimitError ||
		error instanceof PlatformFeedbackSubmissionConflictError
	)
}
