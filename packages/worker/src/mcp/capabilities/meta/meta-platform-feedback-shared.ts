import { z } from 'zod'
import { platformFeedbackSubmissionRateLimit } from '#worker/platform-feedback/limits.ts'
import {
	platformFeedbackCategories,
	platformFeedbackStatuses,
	type PlatformFeedbackSubmitterListItem,
	type PlatformFeedbackSubmitterRecord,
} from '#worker/platform-feedback/types.ts'

export const metaPlatformFeedbackCategorySchema = z.enum(
	platformFeedbackCategories,
)

export const metaPlatformFeedbackStatusSchema = z.enum(platformFeedbackStatuses)

/**
 * Rolling submission quota for the signed-in submitter. Same counting as
 * metaPlatformFeedbackSubmit enforcement (`platformFeedbackSubmissionRateLimit`
 * per 24 hours).
 */
export const metaPlatformFeedbackSubmissionQuotaSchema = z.object({
	submission_rate_limit: z
		.number()
		.int()
		.positive()
		.describe(
			`Max submissions per rolling 24-hour window (${platformFeedbackSubmissionRateLimit}).`,
		),
	submissions_remaining: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'How many more submissions the signed-in user can create in the current rolling 24-hour window.',
		),
	next_slot_at: z
		.string()
		.nullable()
		.describe(
			'ISO timestamp when the next rolling-window slot frees. Null when submissions_remaining > 0.',
		),
})

/**
 * Submitter-visible list fields. Same column names as account export after
 * reviewer redaction; omits details (list) and never includes reviewer/admin
 * columns (`admin_note` stays internal). Includes `resolution_note` and
 * `resolution_pr_urls` when an admin resolved or dismissed the item. For
 * resolved/dismissed rows, `updated_at` is the outcome time.
 */
export const metaPlatformFeedbackListItemSchema = z.object({
	id: z.string(),
	category: metaPlatformFeedbackCategorySchema,
	summary: z.string(),
	status: metaPlatformFeedbackStatusSchema,
	resolution_note: z
		.string()
		.nullable()
		.describe(
			'Submitter-visible outcome note from resolve/dismiss. Null when unset.',
		),
	resolution_pr_urls: z
		.array(z.string())
		.describe(
			'Submitter-visible https PR URLs from resolve/dismiss. Empty when none.',
		),
	created_at: z.string(),
	updated_at: z.string(),
})

export const metaPlatformFeedbackRecordSchema =
	metaPlatformFeedbackListItemSchema.extend({
		details: z.string(),
	})

export function formatMetaPlatformFeedbackListItem(
	feedback: PlatformFeedbackSubmitterListItem,
) {
	return {
		id: feedback.id,
		category: feedback.category,
		summary: feedback.summary,
		status: feedback.status,
		resolution_note: feedback.resolutionNote,
		resolution_pr_urls: feedback.resolutionPrUrls,
		created_at: feedback.createdAt,
		updated_at: feedback.updatedAt,
	}
}

export function formatMetaPlatformFeedbackRecord(
	feedback: PlatformFeedbackSubmitterRecord,
) {
	return {
		...formatMetaPlatformFeedbackListItem(feedback),
		details: feedback.details,
	}
}
