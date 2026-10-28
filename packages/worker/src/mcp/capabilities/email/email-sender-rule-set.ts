import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	EmailSenderRuleLimitError,
	EmailSenderRuleValidationError,
	upsertEmailSenderRule,
} from '#worker/email/sender-rules.ts'
import {
	emailSenderRuleEffectValues,
	emailSenderRuleKindValues,
} from '#worker/email/types.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'
import { emailSenderRuleSchema, toSenderRule } from './shared.ts'

export const emailSenderRuleSetCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailSenderRuleSet',
		contextRuns: 'allow',
		orgPermission: 'email:write',
		description:
			'Create or update a sender rule for the current org. Classification matches rules on RFC5322 From after trusted Cloudflare Authentication-Results: allow/block/quarantine by address or domain (address beats domain; subdomain suffix matching). Allow overrides auto-quarantine for failed sender authentication; block rejects at SMTP before quota; quarantine stores mail and fires email.message.quarantined instead of email.message.received.',
		keywords: [
			'email',
			'sender',
			'rule',
			'allow',
			'block',
			'quarantine',
			'spam',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			kind: z.enum(emailSenderRuleKindValues),
			value: z.string().min(1),
			effect: z.enum(emailSenderRuleEffectValues),
			note: z.string().optional(),
		}),
		outputSchema: z.object({
			rule: emailSenderRuleSchema,
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			try {
				const rule = await upsertEmailSenderRule({
					db: ctx.env.APP_DB,
					userId: emailOwnerOrgId(ctx, user),
					kind: args.kind,
					value: args.value,
					effect: args.effect,
					note: args.note,
				})
				return { rule: toSenderRule(rule) }
			} catch (error) {
				if (
					error instanceof EmailSenderRuleValidationError ||
					error instanceof EmailSenderRuleLimitError
				) {
					throw new Error(error.message)
				}
				throw error
			}
		},
	},
)
