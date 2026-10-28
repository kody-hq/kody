import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { listEmailSenderRules } from '#worker/email/sender-rules.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	emailSenderRuleSchema,
	toSenderRule,
} from '#mcp/capabilities/email/shared.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const outputSchema = z.object({
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
	rules: z.array(emailSenderRuleSchema),
})

export const adminSystemEmailSenderRuleListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminSystemEmailSenderRuleList',
		contextRuns: 'deny',
		description:
			'List sender allow/block/quarantine rules that control inbound spam policy for operator system inboxes (kody@, abuse@, and other reserved locals on the apex domain). Admin-only; never reads user-owned email rules.',
		keywords: [
			'admin',
			'system email',
			'sender rule',
			'spam',
			'quarantine',
			'abuse',
		],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailSenderRuleList',
				async () => {
					const rules = await listEmailSenderRules({
						db: ctx.env.APP_DB,
						userId: systemEmailOwnerId,
					})
					return {
						ownerId: systemEmailOwnerId,
						rules: rules.map(toSenderRule),
					}
				},
			)
		},
	},
)
