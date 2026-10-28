import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { deleteEmailSenderRule } from '#worker/email/sender-rules.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	rule_id: z.string().min(1),
})

const outputSchema = z.object({
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
	deleted: z.literal(true),
})

export const adminSystemEmailSenderRuleDeleteCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminSystemEmailSenderRuleDelete',
		contextRuns: 'deny',
		description:
			'Delete a sender rule that controls inbound spam policy for operator system inboxes (kody@, abuse@, and other reserved locals on the apex domain). Admin-only; never mutates user-owned email rules.',
		keywords: [
			'admin',
			'system email',
			'sender rule',
			'delete',
			'spam',
			'abuse',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailSenderRuleDelete',
				async () => {
					const deleted = await deleteEmailSenderRule({
						db: ctx.env.APP_DB,
						userId: systemEmailOwnerId,
						ruleId: args.rule_id,
					})
					if (!deleted) {
						throw new Error(`Email sender rule not found: ${args.rule_id}`)
					}
					return {
						ownerId: systemEmailOwnerId,
						deleted: true as const,
					}
				},
				{
					successReason: () => `rule_id=${args.rule_id}`,
				},
			)
		},
	})
