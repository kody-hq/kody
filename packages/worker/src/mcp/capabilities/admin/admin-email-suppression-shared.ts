import { z } from 'zod'
import type { RecipientSuppression } from '#worker/email/recipient-suppression.ts'

export const emailSuppressionSchema = z.object({
	recipient: z.string(),
	scope: z
		.enum(['all', 'verification', 'tracking'])
		.describe(
			'all: repeated hard bounces stopped every system email. verification: one verification or password-reset hard bounce stopped those emails only. tracking: below-threshold hard bounces, nothing suppressed yet.',
		),
	hard_bounce_count: z
		.number()
		.int()
		.describe(
			'Recorded system sends that hard-bounced since the last delivery.',
		),
	suppressed_at: z.string().nullable(),
	verification_suppressed_at: z.string().nullable(),
	last_status: z.string(),
	last_detail: z.string().nullable(),
	last_hard_bounce_at: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
})

export function toEmailSuppression(suppression: RecipientSuppression) {
	return {
		recipient: suppression.recipient,
		scope: suppression.scope,
		hard_bounce_count: suppression.hardBounceCount,
		suppressed_at: suppression.suppressedAt,
		verification_suppressed_at: suppression.verificationSuppressedAt,
		last_status: suppression.lastStatus,
		last_detail: suppression.lastDetail,
		last_hard_bounce_at: suppression.lastHardBounceAt,
		created_at: suppression.createdAt,
		updated_at: suppression.updatedAt,
	}
}
