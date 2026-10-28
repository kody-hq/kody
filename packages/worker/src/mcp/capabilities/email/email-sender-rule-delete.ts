import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { deleteEmailSenderRule } from '#worker/email/sender-rules.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'

export const emailSenderRuleDeleteCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailSenderRuleDelete',
		contextRuns: 'allow',
		orgPermission: 'email:write',
		description:
			'Delete one sender allow/block/quarantine rule for the current org.',
		keywords: ['email', 'sender', 'rule', 'delete', 'remove', 'spam'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			rule_id: z.string().min(1),
		}),
		outputSchema: z.object({
			deleted: z.literal(true),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const deleted = await deleteEmailSenderRule({
				db: ctx.env.APP_DB,
				userId: emailOwnerOrgId(ctx, user),
				ruleId: args.rule_id,
			})
			if (!deleted) {
				throw new Error(`Email sender rule not found: ${args.rule_id}`)
			}
			return { deleted: true as const }
		},
	},
)
