import { platformFeedbackContentWarning } from './content-warning.ts'
import type {
	PlatformFeedbackCategory,
	PlatformFeedbackRecord,
} from './types.ts'

export const platformFeedbackSubmittedTopic = 'platform.feedback.submitted'

export type PlatformFeedbackSubmittedEvent = {
	event: typeof platformFeedbackSubmittedTopic
	content_warning: typeof platformFeedbackContentWarning
	admin_url: string
	feedback: {
		id: string
		category: PlatformFeedbackCategory
		status: 'open'
		created_at: string
		summary_untrusted: string
		details_untrusted: string
	}
	submitter: {
		user_id: string
		username: string
		email: string
	}
}

export function buildPlatformFeedbackSubmittedEvent(input: {
	baseUrl: string
	feedback: Pick<
		PlatformFeedbackRecord,
		| 'id'
		| 'submitterUserId'
		| 'submitterUsername'
		| 'submitterEmail'
		| 'category'
		| 'createdAt'
		| 'summary'
		| 'details'
	>
}): PlatformFeedbackSubmittedEvent {
	return {
		event: platformFeedbackSubmittedTopic,
		content_warning: platformFeedbackContentWarning,
		admin_url: `${input.baseUrl}/admin/platform-feedback?feedbackId=${encodeURIComponent(
			input.feedback.id,
		)}`,
		feedback: {
			id: input.feedback.id,
			category: input.feedback.category,
			status: 'open',
			created_at: input.feedback.createdAt,
			summary_untrusted: input.feedback.summary,
			details_untrusted: input.feedback.details,
		},
		submitter: {
			user_id: input.feedback.submitterUserId,
			username: input.feedback.submitterUsername,
			email: input.feedback.submitterEmail,
		},
	}
}
