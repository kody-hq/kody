import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { platformFeedbackSubmissionRateLimit } from '#worker/platform-feedback/limits.ts'
import { listPlatformFeedbackForSubmitter } from '#worker/platform-feedback/service.ts'
import {
	formatMetaPlatformFeedbackListItem,
	metaPlatformFeedbackListItemSchema,
	metaPlatformFeedbackStatusSchema,
	metaPlatformFeedbackSubmissionQuotaSchema,
} from './meta-platform-feedback-shared.ts'
import { requireMcpUser } from './require-user.ts'

export const metaPlatformFeedbackListCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaPlatformFeedbackList',
		orgPermission: 'none',
		description: `List platform feedback submissions owned by the signed-in user, newest first. Optional status filter (open, triaged, resolved, dismissed). Each row has id, category, summary, status, created_at, and updated_at (outcome time when resolved or dismissed). Also returns submissions_remaining and next_slot_at for the rolling ${platformFeedbackSubmissionRateLimit}-submission / 24-hour cap (same counting as metaPlatformFeedbackSubmit). Check remaining quota before asking the user to approve multiple submissions. Never exposes reviewer identity, admin notes, or other users' feedback. Use metaPlatformFeedbackGet for details on one id.`,
		keywords: [
			'platform feedback',
			'feedback status',
			'status of my feedback',
			'my feedback',
			'list feedback',
			'bug report status',
			'friction status',
			'open feedback',
			'feedback quota',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			page: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe('One-indexed feedback page. Defaults to 1.'),
			page_size: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe(
					'Feedback records per page. Defaults to 20 and maxes at 100.',
				),
			status: metaPlatformFeedbackStatusSchema
				.optional()
				.describe('Optional exact status filter.'),
		}),
		outputSchema: z
			.object({
				total: z.number().int().nonnegative(),
				page: z.number().int().positive(),
				page_size: z.number().int().positive(),
				feedback: z.array(metaPlatformFeedbackListItemSchema),
			})
			.merge(metaPlatformFeedbackSubmissionQuotaSchema),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await listPlatformFeedbackForSubmitter({
				db: ctx.env.APP_DB,
				submitterUserId: user.userId,
				page: args.page,
				pageSize: args.page_size,
				status: args.status,
			})
			return {
				total: result.total,
				page: result.page,
				page_size: result.pageSize,
				feedback: result.items.map(formatMetaPlatformFeedbackListItem),
				submission_rate_limit: result.submissionQuota.limit,
				submissions_remaining: result.submissionQuota.remaining,
				next_slot_at: result.submissionQuota.nextSlotAt,
			}
		},
	},
)
