import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getPlatformFeedbackForSubmitter } from '#worker/platform-feedback/service.ts'
import {
	formatMetaPlatformFeedbackRecord,
	metaPlatformFeedbackRecordSchema,
} from './meta-platform-feedback-shared.ts'
import { requireMcpUser } from './require-user.ts'

export const metaPlatformFeedbackGetCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaPlatformFeedbackGet',
		orgPermission: 'none',
		description:
			'Read one platform feedback submission owned by the signed-in user by feedback_id. Returns id, category, summary, details, status, resolution_note, resolution_pr_urls, created_at, and updated_at (outcome time when status is resolved or dismissed). Not-owned ids return null, same as missing. Never exposes reviewer identity or admin notes. Use after metaPlatformFeedbackSubmit, or metaPlatformFeedbackList to find an id.',
		keywords: [
			'platform feedback',
			'feedback status',
			'status of my feedback',
			'my feedback',
			'bug report status',
			'friction status',
			'check feedback',
			'get feedback',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			feedback_id: z
				.string()
				.min(1)
				.describe(
					'Platform feedback id returned by metaPlatformFeedbackSubmit.',
				),
		}),
		outputSchema: metaPlatformFeedbackRecordSchema.nullable(),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const feedback = await getPlatformFeedbackForSubmitter({
				db: ctx.env.APP_DB,
				feedbackId: args.feedback_id,
				submitterUserId: user.userId,
			})
			return feedback ? formatMetaPlatformFeedbackRecord(feedback) : null
		},
	},
)
