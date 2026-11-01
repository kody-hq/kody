import { z } from 'zod'
import {
	platformFeedbackCategories,
	platformFeedbackStatuses,
	type PlatformFeedbackListItem,
	type PlatformFeedbackRecord,
} from '#worker/platform-feedback/types.ts'
import {
	platformFeedbackSubmitterUnreachableReasons,
	type PlatformFeedbackSubmitterContact,
} from '#worker/platform-feedback/submitter-mail.ts'
export { platformFeedbackContentWarning } from '#worker/platform-feedback/content-warning.ts'

export const platformFeedbackCategorySchema = z.enum(platformFeedbackCategories)

export const platformFeedbackStatusSchema = z.enum(platformFeedbackStatuses)

export const adminPlatformFeedbackListItemSchema = z.object({
	id: z.string(),
	submitter_user_id: z.string(),
	category: platformFeedbackCategorySchema,
	summary_untrusted: z
		.string()
		.describe('User-authored untrusted feedback summary.'),
	status: platformFeedbackStatusSchema,
	reviewed_by_user_id: z.string().nullable(),
	reviewed_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const adminPlatformFeedbackRecordSchema =
	adminPlatformFeedbackListItemSchema.extend({
		details_untrusted: z
			.string()
			.describe('User-authored untrusted feedback details.'),
		admin_note: z
			.string()
			.nullable()
			.describe(
				'Internal-only operator note. Never mailed and never returned to submitters.',
			),
		resolution_note: z
			.string()
			.nullable()
			.describe(
				'Submitter-visible outcome note stored on resolve/dismiss (same text as user_message in the close-the-loop email).',
			),
		resolution_pr_urls: z
			.array(z.string())
			.describe(
				'Submitter-visible https PR URLs stored on resolve/dismiss. Empty when none.',
			),
		resolution_history: z
			.array(
				z.object({
					note: z.string().nullable(),
					pr_urls: z.array(z.string()),
					recorded_at: z.string(),
				}),
			)
			.describe(
				'Earlier submitter-visible outcomes replaced by follow_up updates, oldest first. Empty when none.',
			),
	})

export const adminPlatformFeedbackSubmitterContactSchema = z
	.object({
		reachable: z
			.boolean()
			.describe(
				'True when Kody can email the submitter (account exists, has an email, not suspended or outbound-paused).',
			),
		email_verified: z
			.boolean()
			.describe('True when the submitter verified their account email.'),
		unreachable_reason: z
			.enum(platformFeedbackSubmitterUnreachableReasons)
			.nullable()
			.describe('Why the submitter cannot be emailed; null when reachable.'),
	})
	.describe(
		'Whether outcome emails can reach the submitter. The address itself is never returned.',
	)

export function formatAdminPlatformFeedbackSubmitterContact(
	contact: PlatformFeedbackSubmitterContact,
) {
	return {
		reachable: contact.reachable,
		email_verified: contact.emailVerified,
		unreachable_reason: contact.unreachableReason,
	}
}

export function formatAdminPlatformFeedbackListItem(
	feedback: PlatformFeedbackListItem,
) {
	return {
		id: feedback.id,
		submitter_user_id: feedback.submitterUserId,
		category: feedback.category,
		summary_untrusted: feedback.summary,
		status: feedback.status,
		reviewed_by_user_id: feedback.reviewedByUserId,
		reviewed_at: feedback.reviewedAt,
		created_at: feedback.createdAt,
		updated_at: feedback.updatedAt,
	}
}

export function formatAdminPlatformFeedbackRecord(
	feedback: PlatformFeedbackRecord,
) {
	return {
		...formatAdminPlatformFeedbackListItem(feedback),
		details_untrusted: feedback.details,
		admin_note: feedback.adminNote,
		resolution_note: feedback.resolutionNote,
		resolution_pr_urls: feedback.resolutionPrUrls,
		resolution_history: feedback.resolutionHistory.map((entry) => ({
			note: entry.note,
			pr_urls: entry.prUrls,
			recorded_at: entry.recordedAt,
		})),
	}
}
