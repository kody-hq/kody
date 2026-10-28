import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { listEmailSenderRules } from '#worker/email/sender-rules.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'
import { emailSenderRuleSchema, toSenderRule } from './shared.ts'

export const emailSenderRuleListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailSenderRuleList',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'List sender allow/block/quarantine rules for the current org. Classification matches rules on RFC5322 From after trusted Cloudflare Authentication-Results (SPF/DKIM/DMARC): allow overrides auto-quarantine for failed sender authentication; block/quarantine still apply (address beats domain; subdomain suffix matching).',
		keywords: [
			'email',
			'sender',
			'rule',
			'allowlist',
			'blocklist',
			'spam',
			'quarantine',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			rules: z.array(emailSenderRuleSchema),
		}),
		async handler(_args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const rules = await listEmailSenderRules({
				db: ctx.env.APP_DB,
				userId: emailOwnerOrgId(ctx, user),
			})
			return { rules: rules.map(toSenderRule) }
		},
	},
)
