import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	listRecipientSuppressions,
	systemEmailHardBounceSuppressionThreshold,
} from '#worker/email/recipient-suppression.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	emailSuppressionSchema,
	toEmailSuppression,
} from './admin-email-suppression-shared.ts'

const inputSchema = z.object({
	recipient: z
		.string()
		.min(1)
		.optional()
		.describe('Look up one address instead of listing the newest rows.'),
	include_tracking: z
		.boolean()
		.optional()
		.describe(
			'Also return below-threshold rows that have not suppressed anything yet.',
		),
	limit: z.number().int().min(1).max(200).optional(),
})

const outputSchema = z.object({
	threshold: z
		.number()
		.int()
		.describe('Hard bounces that suppress all system email to an address.'),
	suppressions: z.array(emailSuppressionSchema),
	has_more: z.boolean(),
})

export const adminEmailSuppressionListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminEmailSuppressionList',
		contextRuns: 'deny',
		description:
			'List recipient addresses suppressed from Kody system email (kody@ onboarding, usage notices, billing, verification, password reset, operator mail) after hard bounces, newest first. Admin-only; clear a row with adminEmailSuppressionClear.',
		keywords: [
			'admin',
			'email',
			'suppression',
			'bounce',
			'hard bounce',
			'deliverability',
			'kody@',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminEmailSuppressionList',
				async () => {
					const result = await listRecipientSuppressions({
						db: ctx.env.APP_DB,
						recipient: args.recipient ?? null,
						includeTracking: args.include_tracking ?? false,
						limit: args.limit ?? 50,
					})
					return {
						threshold: systemEmailHardBounceSuppressionThreshold,
						suppressions: result.suppressions.map(toEmailSuppression),
						has_more: result.hasMore,
					}
				},
			)
		},
	},
)
